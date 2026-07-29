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

type ComposerErrorCode = SharedPetErrorCode | 'PUBLISH_FAILED';
type DraftField = keyof SharedPetDraft;

function draftErrorMessage(code: ComposerErrorCode, t: ReturnType<typeof useI18n>['t']): string {
  return t(`sharedPet.error.${code}` as Parameters<typeof t>[0]);
}

function errorField(code: ComposerErrorCode | null): DraftField | null {
  switch (code) {
    case 'PACKAGE_REQUIRED':
    case 'PACKAGE_TYPE_INVALID':
    case 'PACKAGE_TOO_LARGE':
      return 'packageFile';
    case 'COVER_REQUIRED':
    case 'COVER_TYPE_INVALID':
    case 'COVER_TOO_LARGE':
      return 'coverFile';
    case 'NAME_REQUIRED':
    case 'NAME_TOO_LONG':
      return 'name';
    case 'DESCRIPTION_REQUIRED':
    case 'DESCRIPTION_TOO_LONG':
      return 'description';
    default:
      return null;
  }
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
  const [errorCode, setErrorCode] = useState<ComposerErrorCode | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const invalidField = errorField(errorCode);
  const error = errorCode ? draftErrorMessage(errorCode, rawTranslate) : null;

  const submit = async () => {
    if (submitting) return;
    const validation = validateSharedPetDraft(draft);
    if (!validation.valid) {
      setErrorCode(validation.code);
      return;
    }

    setErrorCode(null);
    setSubmitting(true);
    try {
      await onSubmit(validation.value);
    } catch {
      setErrorCode('PUBLISH_FAILED');
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
            aria-invalid={invalidField === 'packageFile' ? 'true' : undefined}
            aria-describedby={invalidField === 'packageFile' ? errorId : undefined}
            disabled={submitting}
            onChange={(event) => {
              setErrorCode(null);
              setDraft((current) => ({
                ...current,
                packageFile: event.target.files?.[0] ?? null
              }));
            }}
          />
          {invalidField === 'packageFile' && error ? (
            <p id={errorId} className={styles.error} role="alert">{error}</p>
          ) : null}
        </div>
        <div className={styles.field}>
          <label htmlFor="shared-pet-cover">{t('sharedPet.composer.cover')}</label>
          <input
            id="shared-pet-cover"
            type="file"
            accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
            aria-invalid={invalidField === 'coverFile' ? 'true' : undefined}
            aria-describedby={invalidField === 'coverFile' ? errorId : undefined}
            disabled={submitting}
            onChange={(event) => {
              setErrorCode(null);
              setDraft((current) => ({
                ...current,
                coverFile: event.target.files?.[0] ?? null
              }));
            }}
          />
          {invalidField === 'coverFile' && error ? (
            <p id={errorId} className={styles.error} role="alert">{error}</p>
          ) : null}
        </div>
        <div className={styles.field}>
          <label htmlFor="shared-pet-name">{t('sharedPet.composer.name')}</label>
          <input
            id="shared-pet-name"
            value={draft.name}
            maxLength={30}
            aria-invalid={invalidField === 'name' ? 'true' : undefined}
            aria-describedby={invalidField === 'name' ? errorId : undefined}
            disabled={submitting}
            onChange={(event) => {
              setErrorCode(null);
              setDraft((current) => ({ ...current, name: event.target.value }));
            }}
          />
          {invalidField === 'name' && error ? (
            <p id={errorId} className={styles.error} role="alert">{error}</p>
          ) : null}
        </div>
        <div className={styles.field}>
          <label htmlFor="shared-pet-description">{t('sharedPet.composer.description')}</label>
          <textarea
            id="shared-pet-description"
            value={draft.description}
            maxLength={500}
            aria-invalid={invalidField === 'description' ? 'true' : undefined}
            aria-describedby={invalidField === 'description' ? errorId : undefined}
            disabled={submitting}
            onChange={(event) => {
              setErrorCode(null);
              setDraft((current) => ({ ...current, description: event.target.value }));
            }}
          />
          {invalidField === 'description' && error ? (
            <p id={errorId} className={styles.error} role="alert">{error}</p>
          ) : null}
        </div>
        {invalidField === null && error ? (
          <p id={errorId} className={styles.error} role="alert">{error}</p>
        ) : null}
      </div>
    </SharedPetDialogShell>
  );
}
