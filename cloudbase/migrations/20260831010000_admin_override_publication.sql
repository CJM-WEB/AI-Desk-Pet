BEGIN;

-- 发布依据记录管理裁决，不代替或改写技术扫描事实。
ALTER TABLE submissions
  ADD COLUMN publication_basis text;

-- 历史公开记录均来自旧普通批准路径，前向补齐为标准发布。
UPDATE submissions
SET publication_basis = 'standard'
WHERE status = 'published'
  AND publication_basis IS NULL;

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
BEGIN
  IF COALESCE(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  ) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
  IF p_next_status NOT IN ('manual_review_pending', 'auto_rejected')
    OR jsonb_typeof(p_results) <> 'array'
    OR jsonb_array_length(p_results) > 2500
    OR jsonb_typeof(p_risk_summary) <> 'object' THEN
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

  IF v_late_result AND EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_results) AS result(
      kind text,
      provider text
    )
    WHERE result.kind <> 'package_scan'
      OR result.provider <> 'isolated-scanner'
  ) THEN
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

  IF v_late_result THEN
    UPDATE submissions
    SET risk_summary = p_risk_summary,
        updated_at = now()
    WHERE id = p_submission_id
      AND status = 'published'
      AND status_version = v_submission.status_version
      AND publication_basis = 'admin_override';

    RETURN jsonb_build_object('applied', true, 'lateResult', true);
  END IF;

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

  SELECT status, kind, pre_quarantine_status, cleanup_started_at
  INTO v_previous_status, v_submission_kind, v_pre_quarantine_status,
    v_cleanup_started_at
  FROM submissions
  WHERE id = p_submission_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submission not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_cleanup_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'submission cleanup already started' USING ERRCODE = '40001';
  END IF;

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
    'submission', to_jsonb(v_submission),
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

REVOKE ALL ON FUNCTION apply_moderation_decision(text, bigint, text, jsonb, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_moderation_decision(text, bigint, text, jsonb, jsonb, text)
  TO service_role;
REVOKE ALL ON FUNCTION apply_admin_action(text, text, text, text, bigint, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_admin_action(text, text, text, text, bigint, text, text, text)
  TO service_role;

COMMIT;
