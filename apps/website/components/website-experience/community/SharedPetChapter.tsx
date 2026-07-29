'use client';

import { ChevronLeft, ChevronRight, Upload } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react';
import type { CSSProperties } from 'react';
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

/**
 * 共享仓库章节统一协调分页过渡、仓储写操作和弹窗状态。
 * 卡片与表单只负责展示，所有计数以仓储成功返回的数据为准。
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
  const [composerOpen, setComposerOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<SharedPetPackageSummary | null>(
    null
  );
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const transitionRef = useRef<SharedPetPageTransition>(INITIAL_TRANSITION);
  const pendingPageRef = useRef<Promise<SharedPetPage> | null>(null);
  const gridRef = useRef<HTMLFieldSetElement | null>(null);
  const mountedRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const motionDisabled = !interactive
    || isPaused
    || reducedMotion
    || staticFallback;
  const visiblePage = transition.visiblePage;
  const transitionLocked = transition.status !== 'idle';

  const commitTransition = useCallback((next: SharedPetPageTransition) => {
    transitionRef.current = next;
    setTransition(next);
  }, []);

  const refreshPage = useCallback(async (pageNumber: number) => {
    const sequence = ++refreshSequenceRef.current;
    try {
      let page = await repository.listPage(pageNumber, SHARED_PET_PAGE_SIZE);
      if (page.totalPages > 0 && page.page > page.totalPages) {
        page = await repository.listPage(page.totalPages, SHARED_PET_PAGE_SIZE);
      }
      if (!mountedRef.current || sequence !== refreshSequenceRef.current) return;
      commitTransition({ status: 'idle', visiblePage: page });
      setStatusMessage(null);
    } catch {
      if (!mountedRef.current || sequence !== refreshSequenceRef.current) return;
      setStatusMessage(t('sharedPet.chapter.loadFailed'));
    }
  }, [commitTransition, repository, t]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshPage(1);
    const unsubscribe = repository.subscribe(() => {
      const current = transitionRef.current;
      if (current.status === 'idle') {
        void refreshPage(current.visiblePage.page);
      }
    });
    return () => {
      mountedRef.current = false;
      refreshSequenceRef.current += 1;
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

  const startPageTransition = useCallback((targetPage: number) => {
    const current = transitionRef.current;
    if (!interactive || current.status !== 'idle') return;
    if (targetPage < 1 || targetPage > current.visiblePage.totalPages) return;

    setStatusMessage(null);
    const pending = repository.listPage(targetPage, SHARED_PET_PAGE_SIZE);
    pendingPageRef.current = pending;
    if (motionDisabled || current.visiblePage.items.length === 0) {
      void pending.then((page) => {
        if (!mountedRef.current) return;
        pendingPageRef.current = null;
        commitTransition({ status: 'idle', visiblePage: page });
      }).catch(() => {
        if (!mountedRef.current) return;
        pendingPageRef.current = null;
        setStatusMessage(t('sharedPet.chapter.loadFailed'));
      });
      return;
    }

    const targetPlaceholder = {
      ...current.visiblePage,
      page: targetPage
    };
    commitTransition(beginPageTransition(
      current.visiblePage,
      targetPlaceholder
    ));
  }, [commitTransition, interactive, motionDisabled, repository, t]);

  const finishLeaving = useCallback(async () => {
    const current = transitionRef.current;
    const pending = pendingPageRef.current;
    if (current.status !== 'leaving' || !pending) return;
    try {
      const targetPage = await pending;
      if (!mountedRef.current || transitionRef.current.status !== 'leaving') return;
      pendingPageRef.current = null;
      const loadedTransition = beginPageTransition(
        current.visiblePage,
        targetPage
      );
      const entering = completePageLeaving(loadedTransition);
      if (motionDisabled || entering.visiblePage.items.length === 0) {
        commitTransition(completePageEntering(entering));
        return;
      }
      commitTransition(entering);
    } catch {
      if (!mountedRef.current) return;
      pendingPageRef.current = null;
      commitTransition({ status: 'idle', visiblePage: current.visiblePage });
      setStatusMessage(t('sharedPet.chapter.loadFailed'));
    }
  }, [commitTransition, motionDisabled, t]);

  useEffect(() => {
    if (!motionDisabled) return;
    const current = transitionRef.current;
    if (current.status === 'leaving') {
      void finishLeaving();
    } else if (current.status === 'entering') {
      commitTransition(completePageEntering(current));
    }
  }, [commitTransition, finishLeaving, motionDisabled]);

  const finishEntering = useCallback(() => {
    const current = transitionRef.current;
    if (current.status === 'entering') {
      commitTransition(completePageEntering(current));
    }
  }, [commitTransition]);

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
    if (!interactive) return;
    setStatusMessage(null);
    try {
      const current = await repository.getById(item.id);
      if (!current) throw new Error('PACKAGE_NOT_FOUND');
      if (mountedRef.current) setDetailItem(current);
    } catch {
      if (mountedRef.current) {
        setStatusMessage(t('sharedPet.chapter.detailFailed'));
      }
    }
  };

  const toggleLike = async (item: SharedPetPackageSummary) => {
    if (!interactive) return;
    setStatusMessage(null);
    try {
      const updated = await repository.toggleLike(item.id);
      if (mountedRef.current) replaceVisibleItem(updated);
    } catch {
      if (mountedRef.current) {
        setStatusMessage(t('sharedPet.chapter.likeFailed'));
      }
    }
  };

  const download = async (item: SharedPetPackageSummary) => {
    if (!interactive) return;
    setStatusMessage(null);
    let objectUrl: string | null = null;
    try {
      const payload = await repository.getDownload(item.id);
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
        const releasedUrl = objectUrl;
        objectUrl = null;
        URL.revokeObjectURL(releasedUrl);
      }
      const updated = await repository.recordDownload(item.id);
      if (mountedRef.current) replaceVisibleItem(updated);
    } catch {
      if (mountedRef.current) {
        setStatusMessage(t('sharedPet.error.DOWNLOAD_FAILED'));
      }
    } finally {
      if (objectUrl !== null) {
        const releasedUrl = objectUrl;
        objectUrl = null;
        try {
          URL.revokeObjectURL(releasedUrl);
        } catch {
          // 地址释放失败也属于下载失败，错误状态已由外层流程统一展示。
        }
      }
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
      onPointerMove={(event) => {
        if (!motionDisabled) {
          setPointer({ x: event.clientX, y: event.clientY });
        }
      }}
    >
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
            setStatusMessage(null);
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
              onOpen={(selected) => void openDetail(selected)}
              onLike={(selected) => void toggleLike(selected)}
              onDownload={(selected) => void download(selected)}
            />
          </div>
        ))}
      </fieldset>

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
