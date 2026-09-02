'use client';

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
import type { SubmissionReceipt } from '@myself/shared-types';
import { LIQUID_GLASS_COMMUNITY_CARDS_EVENT } from '../../home-experience/LiquidGlassHome';
import { useI18n } from '../../i18n/I18nProvider';
import type { ChapterRuntimeProps } from '../types';
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
  '--shared-pet-entry-x': string;
  '--shared-pet-entry-opacity': number;
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
  transitionProgress = 3,
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
  const [loadNotice, setLoadNotice] = useState<string | null>(null);
  const [operationNotice, setOperationNotice] = useState<string | null>(null);
  const [submissionReceipt, setSubmissionReceipt] = useState<SubmissionReceipt | null>(null);
  const [submissionProgress, setSubmissionProgress] = useState<number | null>(null);
  const [detailPending, setDetailPending] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [likePending, setLikePending] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [downloadPending, setDownloadPending] = useState<ReadonlySet<string>>(
    new Set()
  );
  const transitionRef = useRef<SharedPetPageTransition>(INITIAL_TRANSITION);
  const activePaginationRef = useRef<ActivePagination | null>(null);
  const gridRef = useRef<HTMLFieldSetElement | null>(null);
  const mountedRef = useRef(false);
  const pageLockedRef = useRef(false);
  const subscriptionDirtyRef = useRef(false);
  const requestEpochRef = useRef(0);
  const paginationTokenRef = useRef(0);
  const statusTokenRef = useRef(0);
  const detailRequestTokenRef = useRef(0);
  const detailLocksRef = useRef(new Set<string>());
  const likeLocksRef = useRef(new Set<string>());
  const downloadLocksRef = useRef(new Set<string>());
  const motionDisabled = !interactive
    || isPaused
    || reducedMotion
    || staticFallback;
  const motionDisabledRef = useRef(motionDisabled);
  motionDisabledRef.current = motionDisabled;
  const visiblePage = transition.visiblePage;
  const transitionLocked = pageLocked || transition.status !== 'idle';
  const statusMessage = operationNotice ?? loadNotice;

  const commitTransition = useCallback((next: SharedPetPageTransition) => {
    transitionRef.current = next;
    setTransition(next);
  }, []);

  const beginStatusOperation = useCallback(() => {
    const token = ++statusTokenRef.current;
    if (mountedRef.current) setOperationNotice(null);
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
        setLoadNotice(t('sharedPet.chapter.loadFailed'));
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
    setLoadNotice(null);
    commitTransition({ status: 'idle', visiblePage: result.page });
  }, [commitTransition, readPage, t]);

  useEffect(() => {
    mountedRef.current = true;
    activePaginationRef.current = null;
    pageLockedRef.current = false;
    subscriptionDirtyRef.current = false;
    commitTransition(INITIAL_TRANSITION);
    setPageLocked(false);
    setLoadNotice(null);
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
      detailRequestTokenRef.current += 1;
      activePaginationRef.current = null;
      pageLockedRef.current = false;
      subscriptionDirtyRef.current = false;
      transitionRef.current = INITIAL_TRANSITION;
      detailLocksRef.current.clear();
      likeLocksRef.current.clear();
      downloadLocksRef.current.clear();
      unsubscribe();
    };
  }, [commitTransition, refreshPage, repository]);

  const replaceVisibleItem = useCallback((updated: SharedPetPackageSummary) => {
    if (!mountedRef.current) return;
    setDetailItem((current) => current?.id === updated.id ? updated : current);
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
    if (targetPage < 1 || (!current.visiblePage.hasNext && targetPage > current.visiblePage.page)) return;

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
          setLoadNotice(null);
          commitTransition({ status: 'idle', visiblePage: result.page });
          unlockPagination(token, result.page.page);
          return;
        }
        if (active.statusToken === statusTokenRef.current) {
          setLoadNotice(t('sharedPet.chapter.loadFailed'));
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
        setLoadNotice(t('sharedPet.chapter.loadFailed'));
      }
      unlockPagination(active.token, current.visiblePage.page);
      return;
    }

    const entering = completePageLeaving(beginPageTransition(
      current.visiblePage,
      result.page
    ));
    setLoadNotice(null);
    if (motionDisabledRef.current || entering.visiblePage.items.length === 0) {
      commitTransition(completePageEntering(entering));
      unlockPagination(active.token, entering.visiblePage.page);
      return;
    }
    commitTransition(entering);
  }, [commitTransition, t, unlockPagination]);

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
  }, [finishEntering, finishLeaving, interactive, motionDisabled]);

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
    const detailToken = ++detailRequestTokenRef.current;
    const statusToken = beginStatusOperation();
    try {
      const current = await repository.getById(item.id);
      if (!current) throw new Error('PACKAGE_NOT_FOUND');
      if (
        mountedRef.current
        && detailToken === detailRequestTokenRef.current
      ) {
        setDetailItem(current);
      }
    } catch {
      if (
        mountedRef.current
        && detailToken === detailRequestTokenRef.current
        && statusToken === statusTokenRef.current
      ) {
        setOperationNotice(t('sharedPet.chapter.detailFailed'));
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
        setOperationNotice(t('sharedPet.chapter.likeFailed'));
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

  const handleDownload = async (item: SharedPetPackageSummary) => {
    if (
      !interactive
      || !beginItemLock(downloadLocksRef.current, setDownloadPending, item.id)
    ) return;
    const token = beginStatusOperation();
    try {
      const payload = await repository.getDownload(item.id);
      if (!mountedRef.current) return;
      if (
        payload.publicationBasis !== undefined
        && payload.publicationBasis !== item.publicationBasis
      ) {
        replaceVisibleItem({
          ...item,
          publicationBasis: payload.publicationBasis
        });
        return;
      }
      if (!payload.url) throw new Error('DOWNLOAD_URL_MISSING');
      const anchor = document.createElement('a');
      anchor.href = payload.url;
      anchor.download = payload.fileName;
      anchor.hidden = true;
      try {
        document.body.append(anchor);
        anchor.click();
      } finally {
        anchor.remove();
      }
    } catch {
      if (
        mountedRef.current
        && token === statusTokenRef.current
      ) {
        setOperationNotice(t('sharedPet.error.DOWNLOAD_FAILED'));
      }
    } finally {
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
    setSubmissionProgress(0);
    const receipt = await repository.submit({
      ...draft,
      packageFile: draft.packageFile,
      coverFile: draft.coverFile
    }, setSubmissionProgress);
    if (!mountedRef.current) return;
    setComposerOpen(false);
    setLoadNotice(null);
    setOperationNotice(null);
    setSubmissionReceipt(receipt);
    setSubmissionProgress(null);
  };

  const pageLabel = visiblePage.totalKnown === false
    ? `${visiblePage.page}/?`
    : visiblePage.totalPages === 0
    ? '0/0'
    : `${visiblePage.page}/${visiblePage.totalPages}`;
  const communityProgress = Math.min(1, Math.max(0, transitionProgress - 2));
  const totalPageLabel = visiblePage.totalKnown === false
    ? '?'
    : String(visiblePage.totalPages);

  /** RAF 合并当前页视觉快照，卸载或翻页时不保留过期帧。 */
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent(LIQUID_GLASS_COMMUNITY_CARDS_EVENT, {
        detail: {
          count: visiblePage.items.length,
          currentPage: visiblePage.page,
          totalPages: totalPageLabel
        }
      }));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [totalPageLabel, visiblePage.items.length, visiblePage.page]);

  const chapterStyle = {
    '--community-progress': communityProgress,
    '--community-share-x': `${(1 - communityProgress) * -74}vw`,
    '--community-repository-x': `${(1 - communityProgress) * 74}vw`,
    '--community-current-y': `${(1 - communityProgress) * -70}vh`,
    '--community-total-y': `${(1 - communityProgress) * 70}vh`
  } as CSSProperties;

  return (
    <section
      className={styles.sharedPetChapter}
      data-testid="shared-pet-chapter"
      data-motion-disabled={motionDisabled}
      data-static-presentation={reducedMotion || staticFallback}
      data-paused={isPaused}
      data-transition={transition.status}
      data-page-locked={pageLocked}
      style={chapterStyle}
    >
      <div className={styles.sharedPetLayout}>
        <h2 className={styles.sharedPetTitle} data-layout-ignore>
          {t('sharedPet.chapter.title')}
        </h2>

        <div className={styles.sharedPetFocus}>
          <span className={styles.currentPageNumber} aria-hidden="true">
            {visiblePage.page}
          </span>
          <button
            className={styles.sharedPetPrevious}
            type="button"
            aria-label={t('sharedPet.chapter.previous')}
            title={t('sharedPet.chapter.previous')}
            disabled={!interactive || transitionLocked || !visiblePage.hasPrevious}
            onClick={() => startPageTransition(visiblePage.page - 1)}
          >
            <span>{t('sharedPet.chapter.shareWord')}</span>
          </button>

          <button
            className={styles.sharedPetUpload}
            type="button"
            aria-label={t('sharedPet.chapter.upload')}
            disabled={!interactive || transitionLocked}
            onClick={() => {
              beginStatusOperation();
              setSubmissionReceipt(null);
              setSubmissionProgress(null);
              setComposerOpen(true);
            }}
          >
            <span aria-hidden="true">AI PET</span>
          </button>

          <button
            className={styles.sharedPetNext}
            type="button"
            aria-label={t('sharedPet.chapter.next')}
            title={t('sharedPet.chapter.next')}
            disabled={!interactive || transitionLocked || !visiblePage.hasNext}
            onClick={() => startPageTransition(visiblePage.page + 1)}
          >
            <span>{t('sharedPet.chapter.repositoryWord')}</span>
          </button>
          <span className={styles.totalPageNumber} aria-hidden="true">
            {totalPageLabel}
          </span>
          <output className={styles.accessiblePageLabel} data-layout-ignore aria-live="polite">
            {pageLabel}
          </output>
          {submissionReceipt ? (
            <div className={styles.sharedPetStatus} role="status">
              <p>{t('sharedPet.submission.received')}</p>
              <a href={`${submissionReceipt.statusPath}#${submissionReceipt.statusToken}`}>
                {t('sharedPet.submission.statusLink')}
              </a>
              <p>{t('sharedPet.submission.saveLink')}</p>
            </div>
          ) : statusMessage ? (
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
              style={{
                '--shared-pet-order': index,
                '--shared-pet-entry-x': `${(1 - Math.min(
                  1,
                  Math.max(0, (communityProgress - 0.10 - index * 0.045) / 0.54)
                )) * 118}vw`,
                '--shared-pet-entry-opacity': Math.min(
                  1,
                  Math.max(0, (communityProgress - 0.10 - index * 0.045) / 0.32)
                )
              } as SharedPetCardStyle}
            >
              <SharedPetCard
                item={item}
                detailDisabled={detailPending.has(item.id)}
                likeDisabled={likePending.has(item.id)}
                downloadDisabled={downloadPending.has(item.id)}
                onOpen={(selected) => void openDetail(selected)}
                onLike={(selected) => void toggleLike(selected)}
                onDownload={(selected) => void handleDownload(selected)}
              />
            </div>
          ))}
        </fieldset>
      </div>

      {composerOpen ? (
        <SharedPetComposerDialog
          onSubmit={submitSharedPet}
          progress={submissionProgress}
          onRequestClose={() => setComposerOpen(false)}
        />
      ) : null}
      {detailItem ? (
        <SharedPetDetailDialog
          item={detailItem}
          downloadDisabled={downloadPending.has(detailItem.id)}
          onDownload={(selected) => void handleDownload(selected)}
          onRequestClose={() => setDetailItem(null)}
        />
      ) : null}
    </section>
  );
}
