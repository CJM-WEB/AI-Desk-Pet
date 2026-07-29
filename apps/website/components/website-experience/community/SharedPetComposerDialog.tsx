'use client';

import { useCallback, useId, useState } from 'react';
import { interpolateMessage, useI18n } from '../../i18n/I18nProvider';
import type { SharedPetErrorCode } from './shared-pet-types';
import { validateSharedPetDraft } from './shared-pet-model';
import { SharedPetDialogShell } from './SharedPetDialogShell';
import styles from './community.module.css';

export interface SharedPetDraft {
  name: string;
  description: string;
  packageFile: File | null;
  coverFile: File | null;
}

export interface SharedPetComposerDialogProps {
  onSubmit: (draft: SharedPetDraft) => void | Promise<void>;
  onRequestClose: () => void;
}

const EMPTY_DRAFT: SharedPetDraft = {
  name: '',
  description: '',
  packageFile: null,
  coverFile: null
};

function draftErrorMessage(code: SharedPetErrorCode, t: ReturnType<typeof useI18n>['t']): string {
  return t(`sharedPet.error.${code}` as Parameters<typeof t>[0]);
}

/** 提供本地校验、文件保留和提交锁定的分享包投稿表单。 */
export function SharedPetComposerDialog({
  onSubmit,
  onRequestClose
}: SharedPetComposerDialogProps) {
  const { t: rawTranslate } = useI18n();
  const t = useCallback((key: Parameters<typeof rawTranslate>[0]) => (
    interpolateMessage(rawTranslate(key))
  ), [rawTranslate]);
  const errorId = useId();
  const [draft, setDraft] = useState<SharedPetDraft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (submitting) return;
    const validation = validateSharedPetDraft(draft);
    if (!validation.valid) {
      setError(draftErrorMessage(validation.code, rawTranslate));
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(validation.value);
    } catch {
      setError(t('sharedPet.error.PUBLISH_FAILED'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SharedPetDialogShell
      title={t('sharedPet.composer.title')}
      closeLabel={t('sharedPet.composer.close')}
      dismissDisabled={submitting}
      onRequestClose={onRequestClose}
      footer={(
        <>
          <button type="button" disabled={submitting} onClick={onRequestClose}>
            {t('sharedPet.composer.cancel')}
          </button>
          <button type="button" disabled={submitting} onClick={() => void submit()}>
            {submitting
              ? t('sharedPet.composer.submitting')
              : t('sharedPet.composer.submit')}
          </button>
        </>
      )}
    >
      <div className={styles.composerFields}>
        <div className={styles.field}>
          <label htmlFor="shared-pet-package">{t('sharedPet.composer.package')}</label>
          <input
            id="shared-pet-package"
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            disabled={submitting}
            onChange={(event) => {
              setError(null);
              setDraft((current) => ({
                ...current,
                packageFile: event.target.files?.[0] ?? null
              }));
            }}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="shared-pet-cover">{t('sharedPet.composer.cover')}</label>
          <input
            id="shared-pet-cover"
            type="file"
            accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
            disabled={submitting}
            onChange={(event) => {
              setError(null);
              setDraft((current) => ({
                ...current,
                coverFile: event.target.files?.[0] ?? null
              }));
            }}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="shared-pet-name">{t('sharedPet.composer.name')}</label>
          <input
            id="shared-pet-name"
            value={draft.name}
            maxLength={30}
            disabled={submitting}
            onChange={(event) => {
              setError(null);
              setDraft((current) => ({ ...current, name: event.target.value }));
            }}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="shared-pet-description">{t('sharedPet.composer.description')}</label>
          <textarea
            id="shared-pet-description"
            value={draft.description}
            maxLength={500}
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={error ? errorId : undefined}
            disabled={submitting}
            onChange={(event) => {
              setError(null);
              setDraft((current) => ({ ...current, description: event.target.value }));
            }}
          />
          {error ? <p id={errorId} className={styles.error} role="alert">{error}</p> : null}
        </div>
      </div>
    </SharedPetDialogShell>
  );
}
