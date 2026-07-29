'use client';

import { ChevronLeft, ChevronRight, Upload } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react';
import type {
  CSSProperties,
  Dispatch,
  SetStateAction
} from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import type { ChapterRuntimeProps } from '../types';
import { PointerTiltText } from '../visual/PointerTiltText';
import {
  beginPageTransition,
  completePageEntering,
  completePageLeaving
} from './shared-pet-model';
import { SharedPetCard } from './SharedPetCard';
import {
  SharedPetComposerDialog,
  type SharedPetDraft
} from './SharedPetComposerDialog';
import { SharedPetDetailDialog } from './SharedPetDetailDialog';
import {
  SHARED_PET_PAGE_SIZE,
  type SharedPetPackageSummary,
  type SharedPetPage,
  type SharedPetPageTransition,
  type SharedPetRepository
} from './shared-pet-types';
import styles from './community.module.css';

export interface SharedPetChapterProps extends ChapterRuntimeProps {
  repository: SharedPetRepository;
}

type SharedPetCardStyle = CSSProperties & {
  '--shared-pet-order': number;
};

type PageReadResult =
  | { ok: true; epoch: number; page: SharedPetPage }
  | { ok: false; epoch: number; error: unknown };

interface ActivePagination {
  token: number;
  targetPage: number;
  statusToken: number;
  settled: Promise<PageReadResult>;
}

const EMPTY_PAGE: SharedPetPage = {
  items: [],
  page: 1,
  pageSize: SHARED_PET_PAGE_SIZE,
  total: 0,
  totalPages: 0,
  hasPrevious: false,
  hasNext: false
};

const INITIAL_TRANSITION: SharedPetPageTransition = {
  status: 'idle',
  visiblePage: EMPTY_PAGE
};

function beginItemLock(
  lock: Set<string>,
  setPending: Dispatch<SetStateAction<ReadonlySet<string>>>,
  id: string
): boolean {
  if (lock.has(id)) return false;
  lock.add(id);
  setPending(new Set(lock));
  return true;
}

function endItemLock(
  lock: Set<string>,
  setPending: Dispatch<SetStateAction<ReadonlySet<string>>>,
  id: string,
  mounted: boolean
) {
  lock.delete(id);
  if (mounted) setPending(new Set(lock));
}

/**
 * 共享仓库章节统一协调分页状态机和条目操作。
 * 所有异步提交都经过 epoch、token 或条目锁校验，避免旧结果覆盖新界面。
 */
export function SharedPetChapter({
  interactive,
  isPaused = false,
  reducedMotion = false,
  staticFallback = false,
  repository
}: SharedPetChapterProps) {
  const { t } = useI18n();
  const [transition, setTransition] = useState<SharedPetPageTransition>(
    INITIAL_TRANSITION
  );
  const [pageLocked, setPageLocked] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<SharedPetPackageSummary | null>(
    null
  );
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [detailPending, setDetailPending] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [likePending, setLikePending] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [downloadPending, setDownloadPending] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const transitionRef = useRef<SharedPetPageTransition>(INITIAL_TRANSITION);
  const activePaginationRef = useRef<ActivePagination | null>(null);
  const gridRef = useRef<HTMLFieldSetElement | null>(null);
  const mountedRef = useRef(false);
  const pageLockedRef = useRef(false);
  const subscriptionDirtyRef = useRef(false);
  const requestEpochRef = useRef(0);
  const paginationTokenRef = useRef(0);
  const statusTokenRef = useRef(0);
  const detailLocksRef = useRef(new Set<string>());
  const likeLocksRef = useRef(new Set<string>());
  const downloadLocksRef = useRef(new Set<string>());
  const motionDisabled = !interactive
    || isPaused
    || reducedMotion
    || staticFallback;
  const visiblePage = transition.visiblePage;
  const transitionLocked = pageLocked || transition.status !== 'idle';

  const commitTransition = useCallback((next: SharedPetPageTransition) => {
    transitionRef.current = next;
    setTransition(next);
  }, []);

  const beginStatusOperation = useCallback(() => {
    const token = ++statusTokenRef.current;
    if (mountedRef.current) setStatusMessage(null);
    return token;
  }, []);

  /**
   * 每次页面读取都递增同一 epoch，并在创建 Promise 时立即挂接拒绝处理。
   */
  const readPage = useCallback((pageNumber: number) => {
    const epoch = ++requestEpochRef.current;
    let settled: Promise<PageReadResult>;
    try {
      settled = repository.listPage(pageNumber, SHARED_PET_PAGE_SIZE).then<PageReadResult, PageReadResult>(
        (page) => ({ ok: true, epoch, page }),
        (error: unknown) => ({ ok: false, epoch, error })
      );
    } catch (error) {
      settled = Promise.resolve({ ok: false, epoch, error });
    }
    return { epoch, settled };
  }, [repository]);

  const refreshPage = useCallback(async (pageNumber: number) => {
    const statusToken = statusTokenRef.current;
    let result = await readPage(pageNumber).settled;
    if (
      !mountedRef.current
      || result.epoch !== requestEpochRef.current
    ) return;

    if (
      result.ok
      && result.page.totalPages > 0
      && result.page.page > result.page.totalPages
    ) {
      result = await readPage(result.page.totalPages).settled;
      if (
        !mountedRef.current
        || result.epoch !== requestEpochRef.current
      ) return;
    }

    if (!result.ok) {
      if (statusToken === statusTokenRef.current) {
        setStatusMessage(t('sharedPet.chapter.loadFailed'));
      }
      return;
    }
    if (
      pageLockedRef.current
      || transitionRef.current.status !== 'idle'
    ) {
      subscriptionDirtyRef.current = true;
      return;
    }
    commitTransition({ status: 'idle', visiblePage: result.page });
  }, [commitTransition, readPage, t]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshPage(1);
    const unsubscribe = repository.subscribe(() => {
      const current = transitionRef.current;
      if (pageLockedRef.current || current.status !== 'idle') {
        subscriptionDirtyRef.current = true;
        return;
      }
      void refreshPage(current.visiblePage.page);
    });
    return () => {
      mountedRef.current = false;
      requestEpochRef.current += 1;
      paginationTokenRef.current += 1;
      statusTokenRef.current += 1;
      activePaginationRef.current = null;
      pageLockedRef.current = false;
      subscriptionDirtyRef.current = false;
      detailLocksRef.current.clear();
      likeLocksRef.current.clear();
      downloadLocksRef.current.clear();
      unsubscribe();
    };
  }, [refreshPage, repository]);

  useEffect(() => {
    if (motionDisabled || typeof window === 'undefined') return;
    const syncViewport = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    syncViewport();
    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, [motionDisabled]);

  const replaceVisibleItem = useCallback((updated: SharedPetPackageSummary) => {
    if (!mountedRef.current) return;
    const current = transitionRef.current;
    const visible = {
      ...current.visiblePage,
      items: current.visiblePage.items.map((item) => (
        item.id === updated.id ? updated : item
      ))
    };
    commitTransition({ ...current, visiblePage: visible });
    setDetailItem((item) => item?.id === updated.id ? updated : item);
  }, [commitTransition]);

  const unlockPagination = useCallback((
    token: number,
    visiblePageNumber: number
  ) => {
    const active = activePaginationRef.current;
    if (!active || active.token !== token) return;
    activePaginationRef.current = null;
    pageLockedRef.current = false;
    if (!mountedRef.current) return;
    setPageLocked(false);
    if (subscriptionDirtyRef.current) {
      subscriptionDirtyRef.current = false;
      void refreshPage(visiblePageNumber);
    }
  }, [refreshPage]);

  const startPageTransition = useCallback((targetPage: number) => {
    const current = transitionRef.current;
    if (
      !interactive
      || pageLockedRef.current
      || current.status !== 'idle'
    ) return;
    if (targetPage < 1 || targetPage > current.visiblePage.totalPages) return;

    const statusToken = beginStatusOperation();
    const token = ++paginationTokenRef.current;
    pageLockedRef.current = true;
    setPageLocked(true);
    const request = readPage(targetPage);
    const active: ActivePagination = {
      token,
      targetPage,
      statusToken,
      settled: request.settled
    };
    activePaginationRef.current = active;

    if (motionDisabled || current.visiblePage.items.length === 0) {
      void active.settled.then((result) => {
        if (
          !mountedRef.current
          || activePaginationRef.current?.token !== token
        ) return;
        if (
          result.ok
          && result.epoch === requestEpochRef.current
        ) {
          commitTransition({ status: 'idle', visiblePage: result.page });
          unlockPagination(token, result.page.page);
          return;
        }
        if (active.statusToken === statusTokenRef.current) {
          setStatusMessage(t('sharedPet.chapter.loadFailed'));
        }
        unlockPagination(token, current.visiblePage.page);
      });
      return;
    }

    commitTransition(beginPageTransition(
      current.visiblePage,
      { ...current.visiblePage, page: targetPage }
    ));
  }, [
    beginStatusOperation,
    commitTransition,
    interactive,
    motionDisabled,
    readPage,
    t,
    unlockPagination
  ]);

  const finishLeaving = useCallback(async () => {
    const current = transitionRef.current;
    const active = activePaginationRef.current;
    if (current.status !== 'leaving' || !active) return;
    const result = await active.settled;
    if (
      !mountedRef.current
      || activePaginationRef.current?.token !== active.token
      || transitionRef.current.status !== 'leaving'
    ) return;

    if (
      !result.ok
      || result.epoch !== requestEpochRef.current
    ) {
      commitTransition({ status: 'idle', visiblePage: current.visiblePage });
      if (active.statusToken === statusTokenRef.current) {
        setStatusMessage(t('sharedPet.chapter.loadFailed'));
      }
      unlockPagination(active.token, current.visiblePage.page);
      return;
    }

    const entering = completePageLeaving(beginPageTransition(
      current.visiblePage,
      result.page
    ));
    if (motionDisabled || entering.visiblePage.items.length === 0) {
      commitTransition(completePageEntering(entering));
      unlockPagination(active.token, entering.visiblePage.page);
      return;
    }
    commitTransition(entering);
  }, [commitTransition, motionDisabled, t, unlockPagination]);

  const finishEntering = useCallback(() => {
    const current = transitionRef.current;
    const active = activePaginationRef.current;
    if (current.status !== 'entering' || !active) return;
    const idle = completePageEntering(current);
    commitTransition(idle);
    unlockPagination(active.token, idle.visiblePage.page);
  }, [commitTransition, unlockPagination]);

  useEffect(() => {
    if (!motionDisabled) return;
    const current = transitionRef.current;
    if (current.status === 'leaving') {
      void finishLeaving();
    } else if (current.status === 'entering') {
      finishEntering();
    }
  }, [finishEntering, finishLeaving, motionDisabled]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const handleAnimationEnd = (event: Event) => {
      const slot = event.target;
      if (!(slot instanceof HTMLElement) || slot.parentElement !== grid) return;
      const index = Number(slot.dataset.sharedPetOrder);
      const current = transitionRef.current;
      if (index !== current.visiblePage.items.length - 1) return;
      if (current.status === 'leaving') {
        void finishLeaving();
      } else if (current.status === 'entering') {
        finishEntering();
      }
    };
    grid.addEventListener('animationend', handleAnimationEnd);
    return () => grid.removeEventListener('animationend', handleAnimationEnd);
  }, [finishEntering, finishLeaving]);

  const openDetail = async (item: SharedPetPackageSummary) => {
    if (
      !interactive
      || !beginItemLock(detailLocksRef.current, setDetailPending, item.id)
    ) return;
    const token = beginStatusOperation();
    try {
      const current = await repository.getById(item.id);
      if (!current) throw new Error('PACKAGE_NOT_FOUND');
      if (
        mountedRef.current
        && token === statusTokenRef.current
      ) {
        setDetailItem(current);
      }
    } catch {
      if (
        mountedRef.current
        && token === statusTokenRef.current
      ) {
        setStatusMessage(t('sharedPet.chapter.detailFailed'));
      }
    } finally {
      endItemLock(
        detailLocksRef.current,
        setDetailPending,
        item.id,
        mountedRef.current
      );
    }
  };

  const toggleLike = async (item: SharedPetPackageSummary) => {
    if (
      !interactive
      || !beginItemLock(likeLocksRef.current, setLikePending, item.id)
    ) return;
    const token = beginStatusOperation();
    try {
      const updated = await repository.toggleLike(item.id);
      replaceVisibleItem(updated);
    } catch {
      if (
        mountedRef.current
        && token === statusTokenRef.current
      ) {
        setStatusMessage(t('sharedPet.chapter.likeFailed'));
      }
    } finally {
      endItemLock(
        likeLocksRef.current,
        setLikePending,
        item.id,
        mountedRef.current
      );
    }
  };

  const download = async (item: SharedPetPackageSummary) => {
    if (
      !interactive
      || !beginItemLock(downloadLocksRef.current, setDownloadPending, item.id)
    ) return;
    const token = beginStatusOperation();
    let objectUrl: string | null = null;
    const revokeObjectUrl = () => {
      if (objectUrl === null) return;
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    };

    try {
      const payload = await repository.getDownload(item.id);
      if (!mountedRef.current) return;
      objectUrl = URL.createObjectURL(payload.file);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = payload.fileName;
      anchor.hidden = true;
      try {
        document.body.append(anchor);
        anchor.click();
      } finally {
        anchor.remove();
        revokeObjectUrl();
      }
      const updated = await repository.recordDownload(item.id);
      replaceVisibleItem(updated);
    } catch {
      if (
        mountedRef.current
        && token === statusTokenRef.current
      ) {
        setStatusMessage(t('sharedPet.error.DOWNLOAD_FAILED'));
      }
    } finally {
      try {
        revokeObjectUrl();
      } catch {
        // 地址释放异常不允许逃逸，下载错误由当前操作统一展示。
      }
      endItemLock(
        downloadLocksRef.current,
        setDownloadPending,
        item.id,
        mountedRef.current
      );
    }
  };

  const submitSharedPet = async (draft: SharedPetDraft) => {
    if (!draft.packageFile || !draft.coverFile) {
      throw new Error('共享包文件不完整');
    }
    await repository.create({
      ...draft,
      packageFile: draft.packageFile,
      coverFile: draft.coverFile
    });
    if (!mountedRef.current) return;
    setComposerOpen(false);
    await refreshPage(1);
  };

  const pageLabel = visiblePage.totalPages === 0
    ? '0/0'
    : `${visiblePage.page}/${visiblePage.totalPages}`;

  return (
    <section
      className={styles.sharedPetChapter}
      data-testid="shared-pet-chapter"
      data-motion-disabled={motionDisabled}
      data-paused={isPaused}
      data-transition={transition.status}
      data-page-locked={pageLocked}
      onPointerMove={(event) => {
        if (!motionDisabled) {
          setPointer({ x: event.clientX, y: event.clientY });
        }
      }}
    >
      <div className={styles.sharedPetLayout}>
        <div className={styles.sharedPetFocus}>
          <h2 className={styles.sharedPetTitle}>
            <PointerTiltText
              pointer={pointer}
              viewport={viewport}
              disabled={motionDisabled}
            >
              {t('sharedPet.chapter.title')}
            </PointerTiltText>
          </h2>
          <button
            className={styles.sharedPetUpload}
            type="button"
            disabled={!interactive || transitionLocked}
            onClick={() => {
              beginStatusOperation();
              setComposerOpen(true);
            }}
          >
            <Upload aria-hidden="true" />
            <span>{t('sharedPet.chapter.upload')}</span>
          </button>
          <div className={styles.sharedPetPagination}>
            <button
              type="button"
              aria-label={t('sharedPet.chapter.previous')}
              title={t('sharedPet.chapter.previous')}
              disabled={!interactive || transitionLocked || !visiblePage.hasPrevious}
              onClick={() => startPageTransition(visiblePage.page - 1)}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <output aria-live="polite">{pageLabel}</output>
            <button
              type="button"
              aria-label={t('sharedPet.chapter.next')}
              title={t('sharedPet.chapter.next')}
              disabled={!interactive || transitionLocked || !visiblePage.hasNext}
              onClick={() => startPageTransition(visiblePage.page + 1)}
            >
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
          {statusMessage ? (
            <p className={styles.sharedPetStatus} role="alert">{statusMessage}</p>
          ) : visiblePage.total === 0 ? (
            <p className={styles.sharedPetStatus}>{t('sharedPet.chapter.empty')}</p>
          ) : null}
        </div>

        <fieldset
          ref={gridRef}
          className={styles.sharedPetGrid}
          disabled={!interactive || transitionLocked}
          aria-label={t('sharedPet.chapter.title')}
        >
          {visiblePage.items.map((item, index) => (
            <div
              key={item.id}
              className={styles.sharedPetCardSlot}
              data-testid="shared-pet-card"
              data-shared-pet-order={index}
              style={{ '--shared-pet-order': index } as SharedPetCardStyle}
            >
              <SharedPetCard
                item={item}
                detailDisabled={detailPending.has(item.id)}
                likeDisabled={likePending.has(item.id)}
                downloadDisabled={downloadPending.has(item.id)}
                onOpen={(selected) => void openDetail(selected)}
                onLike={(selected) => void toggleLike(selected)}
                onDownload={(selected) => void download(selected)}
              />
            </div>
          ))}
        </fieldset>
      </div>

      {composerOpen ? (
        <SharedPetComposerDialog
          onSubmit={submitSharedPet}
          onRequestClose={() => setComposerOpen(false)}
        />
      ) : null}
      {detailItem ? (
        <SharedPetDetailDialog
          item={detailItem}
          onRequestClose={() => setDetailItem(null)}
        />
      ) : null}
    </section>
  );
}
