BEGIN;

-- 已提交迁移保持不可变；通过新的前向版本收紧后到扫描租约有效期。
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

COMMIT;
