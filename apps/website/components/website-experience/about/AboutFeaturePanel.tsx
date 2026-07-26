'use client';

import type {
  FocusEvent,
  PointerEvent as ReactPointerEvent
} from 'react';
import {
  CheckCircle2,
  FileText,
  Folder,
  FolderOpen,
  LayoutGrid,
  LockKeyhole,
  MessageCircleMore,
  Search,
  ShieldCheck,
  Sparkles,
  Type
} from 'lucide-react';
import type { AboutFeature } from './about-content';
import styles from './about.module.css';

export interface AboutFeaturePanelProps {
  feature: AboutFeature;
  active: boolean;
  interactive: boolean;
  mobile: boolean;
  onHoverChange: (id: AboutFeature['id'] | null, anchor: HTMLButtonElement | null) => void;
  onFocusChange: (id: AboutFeature['id'] | null, anchor: HTMLButtonElement | null) => void;
  onMobileToggle: (id: AboutFeature['id']) => void;
}

function SecurityMockup() {
  return (
    <div className={styles.securityMockup} aria-hidden="true">
      <div className={styles.securityRail}>
        <ShieldCheck />
        <LockKeyhole />
        <Folder />
      </div>
      <div className={styles.securityContent}>
        <div className={styles.mockupLineWide} />
        <div className={styles.securityStatus}>
          <CheckCircle2 />
          <span />
        </div>
        <div className={styles.mockupLineMedium} />
        <div className={styles.mockupLineShort} />
      </div>
    </div>
  );
}

function FileManagerMockup() {
  return (
    <div className={styles.fileManagerMockup} aria-hidden="true">
      <div className={styles.fileManagerTopbar}>
        <FolderOpen />
        <span />
        <Search />
      </div>
      <div className={styles.fileManagerBody}>
        <div className={styles.fileManagerRail}>
          <span />
          <span />
          <span />
        </div>
        <div className={styles.fileManagerRows}>
          <div><Folder /><span /></div>
          <div><FileText /><span /></div>
          <div><Folder /><span /></div>
        </div>
      </div>
    </div>
  );
}

function TextEditorMockup() {
  return (
    <div className={styles.textEditorMockup} aria-hidden="true">
      <div className={styles.editorTopbar}>
        <Type />
        <span />
        <span />
        <span />
      </div>
      <div className={styles.editorPage}>
        <div className={styles.mockupLineWide} />
        <div className={styles.mockupLineMedium} />
        <div className={styles.mockupLineWide} />
        <div className={styles.mockupLineShort} />
      </div>
      <div className={styles.editorStatus}><span /><span /></div>
    </div>
  );
}

function CompanionChatMockup() {
  return (
    <div className={styles.companionMockup} aria-hidden="true">
      <div className={styles.companionTopbar}>
        <MessageCircleMore />
        <span />
        <Sparkles />
      </div>
      <div className={styles.chatMessages}>
        <span className={styles.chatBubbleLeft} />
        <span className={styles.chatBubbleRight} />
        <span className={styles.chatBubbleLeft} />
      </div>
      <div className={styles.chatComposer}><span /><span /></div>
    </div>
  );
}

function DesktopOrganizerMockup() {
  return (
    <div className={styles.desktopMockup} aria-hidden="true">
      <div className={styles.desktopTopbar}><LayoutGrid /><span /></div>
      <div className={styles.desktopGrid}>
        <span><Folder /></span>
        <span><FileText /></span>
        <span><Folder /></span>
        <span><FileText /></span>
        <span><Folder /></span>
        <span><FileText /></span>
      </div>
    </div>
  );
}

function FeatureIllustration({ feature }: { feature: AboutFeature }) {
  switch (feature.illustration) {
    case 'security': return <SecurityMockup />;
    case 'file-management': return <FileManagerMockup />;
    case 'text-editor': return <TextEditorMockup />;
    case 'companion-chat': return <CompanionChatMockup />;
    case 'desktop-organizer': return <DesktopOrganizerMockup />;
  }
}

/**
 * 单个介绍功能区只负责自身可访问交互；桌面态不写入点击锁定，移动态才转交轻触锁定。
 */
export function AboutFeaturePanel({
  feature,
  active,
  interactive,
  mobile,
  onHoverChange,
  onFocusChange,
  onMobileToggle
}: AboutFeaturePanelProps) {
  const Icon = feature.icon;
  const handlePointerEnter = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!interactive || mobile || event.pointerType === 'touch') return;
    onHoverChange(feature.id, event.currentTarget);
  };
  const handlePointerLeave = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!interactive || mobile || event.pointerType === 'touch') return;
    onHoverChange(null, null);
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!interactive || mobile || event.pointerType !== 'mouse') return;
    event.preventDefault();
  };
  const handleFocus = (event: FocusEvent<HTMLButtonElement>) => {
    if (!interactive || mobile) return;
    onFocusChange(feature.id, event.currentTarget);
  };
  const handleBlur = () => {
    if (!interactive || mobile) return;
    onFocusChange(null, null);
  };

  return (
    <button
      className={styles.featurePanel}
      type="button"
      disabled={!interactive}
      tabIndex={interactive ? 0 : -1}
      data-about-feature={feature.id}
      data-about-illustration={feature.illustration}
      data-entry-order={feature.entryOrder}
      data-active={active}
      aria-label={feature.title}
      aria-describedby={active ? `about-feature-preview-${feature.id}` : undefined}
      onPointerDown={handlePointerDown}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onClick={(event) => {
        if (!interactive || !mobile) return;
        event.stopPropagation();
        onMobileToggle(feature.id);
      }}
    >
      <span className={styles.panelChrome} aria-hidden="true">
        <span className={styles.panelIcon}><Icon /></span>
        <span className={styles.panelEyebrow}>{feature.eyebrow}</span>
      </span>
      <span className={styles.panelText}>
        <strong>{feature.title}</strong>
        <span>{feature.summary}</span>
      </span>
      <span className={styles.panelIllustration}>
        <FeatureIllustration feature={feature} />
      </span>
    </button>
  );
}
