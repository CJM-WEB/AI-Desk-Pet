BEGIN;

-- 发布依据记录管理裁决，不代替或改写技术扫描事实。
ALTER TABLE submissions
  ADD COLUMN publication_basis text;

-- 历史公开记录均来自旧普通批准路径，前向补齐为标准发布。
UPDATE submissions
SET publication_basis = 'standard'
WHERE status = 'published'
  AND publication_basis IS NULL;

-- 旧函数曾把整行投稿写入审计快照；升级时只保留稳定回放所需的公开事实。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM admin_audit_logs AS audit
    WHERE audit.result_snapshot #>> '{submission,status}' = 'purged'
      AND audit.result_snapshot #> '{submission,status_version}' IS NULL
      AND (
        audit.request_payload ->> 'submissionId' = audit.submission_id
        AND audit.request_payload ->> 'adminId' = audit.admin_id
        AND audit.request_payload ->> 'action' = audit.action
        AND audit.request_payload ->> 'nextStatus' = audit.after_status
        AND audit.request_payload ->> 'reason' = audit.reason
        AND audit.before_status <> audit.after_status
        AND jsonb_typeof(
          audit.request_payload -> 'expectedVersion'
        ) = 'number'
        AND audit.request_payload ->> 'expectedVersion' ~ '^[0-9]+$'
      ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'invalid legacy admin audit snapshot'
      USING ERRCODE = '22023';
  END IF;
END;
$$;

UPDATE admin_audit_logs AS audit
SET result_snapshot = CASE
  WHEN audit.result_snapshot #>> '{submission,status}' = 'purged'
    AND audit.result_snapshot #> '{submission,status_version}' IS NULL
  THEN jsonb_build_object(
    'submission', jsonb_build_object(
      'id', audit.submission_id,
      'status', audit.after_status,
      'status_version',
        (audit.request_payload ->> 'expectedVersion')::bigint + 1,
      'publication_basis', CASE
        WHEN audit.after_status = 'published' THEN 'standard'::text
        ELSE NULL
      END
    ),
    'replayed', false
  )
  ELSE jsonb_build_object(
    'submission', jsonb_build_object(
      'id', COALESCE(
        audit.result_snapshot #> '{submission,id}',
        to_jsonb(audit.submission_id)
      ),
      'kind', COALESCE(
        audit.result_snapshot #> '{submission,kind}',
        to_jsonb(submission.kind)
      ),
      'status', audit.result_snapshot #> '{submission,status}',
      'status_version', audit.result_snapshot #> '{submission,status_version}',
      'publication_basis', CASE
        WHEN audit.result_snapshot #>> '{submission,status}' = 'published'
          THEN COALESCE(
            audit.result_snapshot #> '{submission,publication_basis}',
            to_jsonb('standard'::text)
          )
        ELSE 'null'::jsonb
      END,
      'public_reason', audit.result_snapshot #> '{submission,public_reason}',
      'published_at', audit.result_snapshot #> '{submission,published_at}',
      'rejected_at', audit.result_snapshot #> '{submission,rejected_at}',
      'quarantined_at', audit.result_snapshot #> '{submission,quarantined_at}',
      'created_at', audit.result_snapshot #> '{submission,created_at}',
      'updated_at', audit.result_snapshot #> '{submission,updated_at}'
    ),
    'replayed', false
  )
END
FROM submissions AS submission
WHERE submission.id = audit.submission_id;

ALTER TABLE submissions
  ADD CONSTRAINT submissions_publication_basis_check
  CHECK (
    (status = 'published'
      AND publication_basis IS NOT NULL
      AND publication_basis IN ('standard', 'admin_override'))
    OR (status <> 'published' AND publication_basis IS NULL)
  );

CREATE INDEX submissions_publication_basis_idx
  ON submissions (publication_basis, published_at DESC, id DESC)
  WHERE status = 'published';

-- 已领取任务的后到结果只追加技术事实和风险，不发起第二次状态裁决。
CREATE OR REPLACE FUNCTION apply_moderation_decision(
  p_submission_id text,
  p_expected_version bigint,
  p_next_status text,
  p_results jsonb,
  p_risk_summary jsonb,
  p_auto_rejection_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_submission submissions%ROWTYPE;
  v_late_result boolean;
  v_late_technical_count bigint;
  v_late_technical_result jsonb;
  v_late_suggestion text;
  v_late_label text;
  v_late_risk_summary jsonb;
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_next_status IS NULL
    OR p_results IS NULL
    OR p_risk_summary IS NULL
    OR p_next_status NOT IN ('manual_review_pending', 'auto_rejected')
    OR jsonb_typeof(p_results) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_risk_summary) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid moderation decision' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_results) > 2500 THEN
    RAISE EXCEPTION 'invalid moderation decision' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_submission
  FROM submissions
  WHERE id = p_submission_id
  FOR UPDATE;

  v_late_result := FOUND
    AND v_submission.kind = 'shared_package'
    AND v_submission.status = 'published'
    AND v_submission.publication_basis = 'admin_override'
    AND v_submission.moderation_lease_until IS NOT NULL
    AND v_submission.moderation_lease_until > now()
    AND v_submission.status_version = p_expected_version + 2;

  IF NOT FOUND OR (
    NOT v_late_result
    AND (
      v_submission.status <> 'system_reviewing'
      OR v_submission.status_version <> p_expected_version
    )
  ) THEN
    RETURN jsonb_build_object('applied', false);
  END IF;

  IF v_late_result THEN
    SELECT count(*) INTO v_late_technical_count
    FROM jsonb_array_elements(p_results) AS result(value)
    WHERE result.value ->> 'kind' = 'package_scan'
      AND result.value ->> 'provider' = 'isolated-scanner';
    IF v_late_technical_count <> 1 THEN
      RAISE EXCEPTION 'invalid late moderation result' USING ERRCODE = '22023';
    END IF;
    SELECT result.value INTO v_late_technical_result
    FROM jsonb_array_elements(p_results) AS result(value)
    WHERE result.value ->> 'kind' = 'package_scan'
      AND result.value ->> 'provider' = 'isolated-scanner';
    v_late_suggestion := v_late_technical_result ->> 'suggestion';
    v_late_label := v_late_technical_result ->> 'label';
    IF jsonb_typeof(v_late_technical_result) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_late_technical_result -> 'rule_version')
        IS DISTINCT FROM 'string'
      OR length(v_late_technical_result ->> 'rule_version') = 0
      OR jsonb_typeof(v_late_technical_result -> 'suggestion')
        IS DISTINCT FROM 'string'
      OR v_late_suggestion NOT IN ('Pass', 'Block')
      OR jsonb_typeof(v_late_technical_result -> 'label')
        IS DISTINCT FROM 'string'
      OR length(v_late_label) = 0
      OR length(v_late_label) > 100
      OR (
        jsonb_typeof(v_late_technical_result -> 'score')
          IS DISTINCT FROM 'number'
        AND jsonb_typeof(v_late_technical_result -> 'score')
          IS DISTINCT FROM 'null'
      )
      OR jsonb_typeof(v_late_technical_result -> 'evidence')
        IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_late_technical_result -> 'requested_at')
        IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_late_technical_result -> 'completed_at')
        IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_late_technical_result -> 'error_message')
        IS DISTINCT FROM 'null' THEN
      RAISE EXCEPTION 'invalid late moderation result' USING ERRCODE = '22023';
    END IF;

    INSERT INTO moderation_results (
      submission_id, kind, provider, rule_version, suggestion, label, score,
      evidence, requested_at, completed_at, error_message
    )
    SELECT
      p_submission_id, result.kind, result.provider, result.rule_version,
      result.suggestion, result.label, result.score, result.evidence,
      result.requested_at, result.completed_at, result.error_message
    FROM jsonb_to_record(v_late_technical_result) AS result(
      kind text,
      provider text,
      rule_version text,
      suggestion text,
      label text,
      score double precision,
      evidence jsonb,
      requested_at timestamptz,
      completed_at timestamptz,
      error_message text
    );
    v_late_risk_summary := jsonb_build_object(
      'blocked', v_late_suggestion = 'Block',
      'signalCount', 1,
      'blockedLabels', CASE
        WHEN v_late_suggestion = 'Block' THEN jsonb_build_array(v_late_label)
        ELSE '[]'::jsonb
      END
    );
    UPDATE submissions
    SET risk_summary = v_late_risk_summary,
        moderation_lease_until = NULL,
        updated_at = now()
    WHERE id = p_submission_id
      AND status = 'published'
      AND status_version = v_submission.status_version
      AND publication_basis = 'admin_override';

    RETURN jsonb_build_object('applied', true, 'lateResult', true);
  END IF;

  INSERT INTO moderation_results (
    submission_id, kind, provider, rule_version, suggestion, label, score,
    evidence, requested_at, completed_at, error_message
  )
  SELECT
    p_submission_id, result.kind, result.provider, result.rule_version,
    result.suggestion, result.label, result.score, result.evidence,
    result.requested_at, result.completed_at, result.error_message
  FROM jsonb_to_recordset(p_results) AS result(
    kind text,
    provider text,
    rule_version text,
    suggestion text,
    label text,
    score double precision,
    evidence jsonb,
    requested_at timestamptz,
    completed_at timestamptz,
    error_message text
  );

  UPDATE assets AS asset
  SET sha256 = result.evidence ->> 'archiveSha256',
      scan_status = 'safe',
      updated_at = now()
  FROM moderation_results AS result
  WHERE result.submission_id = p_submission_id
    AND result.kind = 'package_scan'
    AND result.provider = 'isolated-scanner'
    AND result.suggestion = 'Pass'
    AND asset.submission_id = p_submission_id
    AND asset.role = 'package'
    AND result.evidence ->> 'packageStorageKey' = asset.object_key
    AND jsonb_typeof(result.evidence -> 'packageSizeBytes') = 'number'
    AND jsonb_typeof(result.evidence -> 'archiveSizeBytes') = 'number'
    AND jsonb_typeof(result.evidence -> 'submissionStatusVersion') = 'number'
    AND result.evidence ->> 'submissionId' = p_submission_id
    AND (result.evidence ->> 'submissionStatusVersion')::bigint
      = p_expected_version + 1
    AND result.evidence ->> 'protocolVersion' = '2026-08-15'
    AND result.evidence ->> 'ruleVersion' = result.rule_version
    AND result.evidence ->> 'scanCode' = 'CHARACTER_PACKAGE_SCAN_PASSED'
    AND (result.evidence ->> 'packageSizeBytes')::bigint = asset.actual_size
    AND (result.evidence ->> 'archiveSizeBytes')::bigint = asset.actual_size
    AND result.evidence ->> 'archiveSha256' ~ '^[a-f0-9]{64}$';

  IF v_submission.kind = 'shared_package'
    AND p_next_status = 'manual_review_pending'
    AND NOT technical_scan_evidence_valid(
      p_submission_id,
      p_expected_version + 1,
      now()
    ) THEN
    RAISE EXCEPTION 'technical scan required' USING ERRCODE = 'P1003';
  END IF;

  UPDATE submissions
  SET status = p_next_status,
      status_version = status_version + 1,
      risk_summary = p_risk_summary,
      auto_rejection_reason = CASE
        WHEN p_next_status = 'auto_rejected'
          THEN left(p_auto_rejection_reason, 500)
        ELSE NULL
      END,
      rejected_at = CASE
        WHEN p_next_status = 'auto_rejected' THEN now()
        ELSE NULL
      END,
      purge_after = CASE
        WHEN p_next_status = 'auto_rejected' THEN now() + interval '3 days'
        ELSE NULL
      END,
      moderation_lease_until = NULL,
      moderation_next_retry_at = NULL,
      moderation_last_error = NULL,
      updated_at = now()
  WHERE id = p_submission_id
    AND status = 'system_reviewing'
    AND status_version = p_expected_version;

  RETURN jsonb_build_object('applied', true, 'lateResult', false);
END;
$$;

-- 用可选第八参数扩展原 RPC；七参数调用继续使用默认 NULL。
DROP FUNCTION apply_admin_action(text, text, text, text, bigint, text, text);
CREATE FUNCTION apply_admin_action(
  p_submission_id text,
  p_admin_id text,
  p_action text,
  p_next_status text,
  p_expected_version bigint,
  p_idempotency_key text,
  p_reason text,
  p_risk_acknowledgement text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing admin_audit_logs%ROWTYPE;
  v_previous_status text;
  v_submission_kind text;
  v_pre_quarantine_status text;
  v_cleanup_started_at timestamptz;
  v_request_identity jsonb;
  v_request_payload jsonb;
  v_latest_scan_summary jsonb;
  v_submission submissions%ROWTYPE;
  v_result jsonb;
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  -- 风险确认是动作级安全门，必须在幂等回放之前严格校验。
  IF (p_action = 'force_publish'
      AND p_risk_acknowledgement IS DISTINCT FROM 'ADMIN_OVERRIDE_ACCEPTED')
    OR (p_action <> 'force_publish' AND p_risk_acknowledgement IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid admin action' USING ERRCODE = 'P1002';
  END IF;

  v_request_identity := jsonb_build_object(
    'submissionId', p_submission_id,
    'adminId', p_admin_id,
    'action', p_action,
    'nextStatus', p_next_status,
    'expectedVersion', p_expected_version,
    'reason', p_reason,
    'riskAcknowledgement', p_risk_acknowledgement
  );

  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 0));

  -- 幂等事实先于当前投稿生命周期，cleanup 与 purge 不得破坏首次回放。
  SELECT * INTO v_existing
  FROM admin_audit_logs
  WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF (v_existing.request_payload - 'latestScanSummary' - 'riskAcknowledgement')
        <> (v_request_identity - 'riskAcknowledgement')
      OR COALESCE(
        v_existing.request_payload -> 'riskAcknowledgement',
        'null'::jsonb
      ) IS DISTINCT FROM (
        jsonb_build_object('riskAcknowledgement', p_risk_acknowledgement)
          -> 'riskAcknowledgement'
      ) THEN
      RAISE EXCEPTION 'idempotency key reused with different input'
        USING ERRCODE = 'P1001';
    END IF;
    RETURN v_existing.result_snapshot || jsonb_build_object('replayed', true);
  END IF;

  SELECT status, kind, pre_quarantine_status, cleanup_started_at
  INTO v_previous_status, v_submission_kind, v_pre_quarantine_status,
    v_cleanup_started_at
  FROM submissions
  WHERE id = p_submission_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_cleanup_started_at IS NOT NULL AND v_previous_status <> 'purged' THEN
    RAISE EXCEPTION 'submission cleanup already started' USING ERRCODE = '40001';
  END IF;

  IF NOT (
    (p_action = 'approve'
      AND v_previous_status = 'manual_review_pending'
      AND p_next_status = 'published')
    OR (p_action = 'force_publish'
      AND v_submission_kind = 'shared_package'
      AND v_previous_status = 'manual_review_pending'
      AND p_next_status = 'published')
    OR (p_action = 'reject'
      AND v_previous_status = 'manual_review_pending'
      AND p_next_status = 'admin_rejected')
    OR (p_action = 'move_to_manual'
      AND v_previous_status IN ('system_reviewing', 'auto_rejected')
      AND p_next_status = 'manual_review_pending')
    OR (p_action = 'delete'
      AND v_previous_status NOT IN ('purged', 'deleted_quarantined')
      AND p_next_status = 'deleted_quarantined')
    OR (p_action = 'restore'
      AND v_previous_status = 'deleted_quarantined'
      AND p_next_status = CASE
        WHEN v_submission_kind = 'shared_package'
          THEN 'system_reviewing'
        ELSE v_pre_quarantine_status
      END)
  ) THEN
    RAISE EXCEPTION 'invalid admin action' USING ERRCODE = 'P1002';
  END IF;

  IF p_action = 'approve'
    AND v_submission_kind = 'shared_package'
    AND NOT technical_scan_evidence_valid(
      p_submission_id,
      p_expected_version,
      now()
    ) THEN
    RAISE EXCEPTION 'technical scan required' USING ERRCODE = 'P1003';
  END IF;

  IF p_action = 'force_publish'
    AND technical_scan_evidence_valid(
      p_submission_id,
      p_expected_version,
      now()
    ) THEN
    RAISE EXCEPTION 'invalid admin action' USING ERRCODE = 'P1002';
  END IF;

  SELECT jsonb_build_object(
    'kind', result.kind,
    'provider', result.provider,
    'ruleVersion', result.rule_version,
    'suggestion', result.suggestion,
    'label', result.label,
    'scanCode', result.evidence ->> 'scanCode',
    'completedAt', result.completed_at
  )
  INTO v_latest_scan_summary
  FROM moderation_results AS result
  WHERE result.submission_id = p_submission_id
    AND result.kind = 'package_scan'
  ORDER BY result.completed_at DESC NULLS LAST, result.id DESC
  LIMIT 1;

  v_request_payload := v_request_identity || jsonb_build_object(
    'latestScanSummary', v_latest_scan_summary
  );

  UPDATE submissions
  SET status = p_next_status,
      status_version = status_version + 1,
      publication_basis = CASE
        WHEN p_action = 'approve' THEN 'standard'
        WHEN p_action = 'force_publish' THEN 'admin_override'
        WHEN p_action = 'restore'
          AND v_submission_kind <> 'shared_package'
          AND v_pre_quarantine_status = 'published' THEN 'standard'
        WHEN p_next_status <> 'published' THEN NULL
        ELSE publication_basis
      END,
      published_at = CASE
        WHEN p_next_status = 'published' THEN COALESCE(published_at, now())
        ELSE published_at
      END,
      public_reason = CASE
        WHEN p_action = 'reject' THEN left(p_reason, 500)
        WHEN p_action IN (
          'approve', 'force_publish', 'move_to_manual', 'restore'
        ) THEN NULL
        ELSE public_reason
      END,
      auto_rejection_reason = CASE
        WHEN p_next_status = 'system_reviewing' THEN NULL
        ELSE auto_rejection_reason
      END,
      risk_summary = CASE
        WHEN p_next_status = 'system_reviewing' THEN '{}'::jsonb
        ELSE risk_summary
      END,
      rejected_at = CASE
        WHEN p_action = 'reject' THEN now()
        WHEN p_action IN (
          'approve', 'force_publish', 'move_to_manual', 'restore'
        ) THEN NULL
        ELSE rejected_at
      END,
      quarantined_at = CASE
        WHEN p_action = 'delete' THEN now()
        WHEN p_action = 'restore' THEN NULL
        ELSE quarantined_at
      END,
      purge_after = CASE
        WHEN p_action IN ('reject', 'delete') THEN now() + interval '3 days'
        WHEN p_action IN (
          'approve', 'force_publish', 'move_to_manual', 'restore'
        ) THEN NULL
        ELSE purge_after
      END,
      pre_quarantine_status = CASE
        WHEN p_action = 'delete' THEN v_previous_status
        WHEN p_action = 'restore' THEN NULL
        ELSE pre_quarantine_status
      END,
      moderation_lease_until = CASE
        WHEN p_next_status = 'system_reviewing' THEN NULL
        ELSE moderation_lease_until
      END,
      moderation_attempts = CASE
        WHEN p_next_status = 'system_reviewing' THEN 0
        ELSE moderation_attempts
      END,
      moderation_next_retry_at = CASE
        WHEN p_next_status = 'system_reviewing' THEN NULL
        ELSE moderation_next_retry_at
      END,
      moderation_last_error = CASE
        WHEN p_next_status = 'system_reviewing' THEN NULL
        ELSE moderation_last_error
      END,
      moderation_alerted_at = CASE
        WHEN p_next_status = 'system_reviewing' THEN NULL
        ELSE moderation_alerted_at
      END,
      updated_at = now()
  WHERE id = p_submission_id
    AND status_version = p_expected_version
  RETURNING * INTO v_submission;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission version conflict' USING ERRCODE = '40001';
  END IF;

  IF p_next_status = 'published' THEN
    INSERT INTO public_engagement (submission_id)
    VALUES (p_submission_id)
    ON CONFLICT (submission_id) DO NOTHING;
  END IF;

  v_result := jsonb_build_object(
    'submission', jsonb_build_object(
      'id', v_submission.id,
      'kind', v_submission.kind,
      'status', v_submission.status,
      'status_version', v_submission.status_version,
      'publication_basis', v_submission.publication_basis,
      'public_reason', v_submission.public_reason,
      'published_at', v_submission.published_at,
      'rejected_at', v_submission.rejected_at,
      'quarantined_at', v_submission.quarantined_at,
      'created_at', v_submission.created_at,
      'updated_at', v_submission.updated_at
    ),
    'replayed', false
  );
  INSERT INTO admin_audit_logs (
    submission_id, admin_id, action, before_status, after_status, reason,
    idempotency_key, request_payload, result_snapshot
  )
  VALUES (
    p_submission_id, p_admin_id, p_action, v_previous_status, p_next_status,
    p_reason, p_idempotency_key, v_request_payload, v_result
  );
  RETURN v_result;
END;
$$;

-- purge 只清理投稿私密载荷，不得把已承诺的幂等首次快照改写为后续状态。
CREATE OR REPLACE FUNCTION mark_submission_purged(
  p_submission_id text,
  p_expected_version bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_submission submissions%ROWTYPE;
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_submission
  FROM submissions
  WHERE id = p_submission_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_submission.status_version <> p_expected_version
    OR v_submission.cleanup_lease_until IS NULL
    OR v_submission.cleanup_started_at IS NULL
    OR (
      (
        v_submission.status IN (
          'auto_rejected',
          'admin_rejected',
          'deleted_quarantined'
        )
        AND v_submission.purge_after <= now()
      )
      OR (
        v_submission.status = 'uploading'
        AND v_submission.cleanup_started_at IS NOT NULL
      )
    ) IS NOT TRUE THEN
    RETURN jsonb_build_object('applied', false);
  END IF;

  DELETE FROM assets WHERE submission_id = p_submission_id;
  UPDATE moderation_results
  SET evidence = '{}'::jsonb,
      error_message = NULL
  WHERE submission_id = p_submission_id;
  UPDATE submissions
  SET title = NULL,
      body = NULL,
      status = 'purged',
      status_version = status_version + 1,
      risk_summary = jsonb_build_object('purged', true),
      public_reason = NULL,
      auto_rejection_reason = NULL,
      cleanup_lease_until = NULL,
      purge_after = NULL,
      pre_quarantine_status = NULL,
      updated_at = now()
  WHERE id = p_submission_id
    AND status_version = p_expected_version;
  RETURN jsonb_build_object('applied', true);
END;
$$;

REVOKE ALL ON FUNCTION apply_moderation_decision(text, bigint, text, jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_moderation_decision(text, bigint, text, jsonb, jsonb, text)
  TO service_role;
REVOKE ALL ON FUNCTION apply_admin_action(text, text, text, text, bigint, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_admin_action(text, text, text, text, bigint, text, text, text)
  TO service_role;
REVOKE ALL ON FUNCTION mark_submission_purged(text, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mark_submission_purged(text, bigint)
  TO service_role;

COMMIT;
