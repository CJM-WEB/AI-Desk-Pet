BEGIN;

-- 发布结构只由这一处断言拥有；技术扫描证据仍由现有审核函数独立裁决。
CREATE FUNCTION assert_submission_publication_shape(p_submission_id text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_submission submissions%ROWTYPE;
  v_cover assets%ROWTYPE;
  v_package assets%ROWTYPE;
  v_cover_count bigint;
  v_package_count bigint;
BEGIN
  SELECT * INTO v_submission
  FROM submissions
  WHERE id = p_submission_id;

  -- 删除投稿的级联资产事件以及离开发布态的事件不再需要结构校验。
  IF NOT FOUND OR v_submission.status <> 'published' THEN
    RETURN;
  END IF;
  IF v_submission.kind NOT IN ('shared_package', 'feedback', 'suggestion')
    OR NULLIF(regexp_replace(
      v_submission.title, '[[:space:]]', '', 'g'
    ), '') IS NULL
    OR NULLIF(regexp_replace(
      v_submission.body, '[[:space:]]', '', 'g'
    ), '') IS NULL THEN
    RAISE EXCEPTION 'invalid published submission shape: %', p_submission_id
      USING ERRCODE = 'P1002';
  END IF;

  -- 反馈和建议没有角色包资产要求；共享包必须满足当前上传契约。
  IF v_submission.kind <> 'shared_package' THEN
    RETURN;
  END IF;

  SELECT
    count(*) FILTER (WHERE role = 'cover'),
    count(*) FILTER (WHERE role = 'package')
  INTO v_cover_count, v_package_count
  FROM assets
  WHERE submission_id = p_submission_id;
  IF v_cover_count <> 1 OR v_package_count <> 1 THEN
    RAISE EXCEPTION 'invalid published submission shape: %', p_submission_id
      USING ERRCODE = 'P1002';
  END IF;

  SELECT * INTO STRICT v_cover
  FROM assets
  WHERE submission_id = p_submission_id AND role = 'cover';
  SELECT * INTO STRICT v_package
  FROM assets
  WHERE submission_id = p_submission_id AND role = 'package';

  IF v_package.object_key <> 'submissions/' || p_submission_id || '/package.zip'
    OR v_package.actual_size IS NULL
    OR v_package.actual_size <= 0
    OR v_package.mime_type <> 'application/zip'
    OR v_cover.actual_size IS NULL
    OR v_cover.actual_size <= 0
    OR NOT (
      (v_cover.object_key = 'submissions/' || p_submission_id || '/cover.png'
        AND v_cover.mime_type = 'image/png')
      OR (v_cover.object_key = 'submissions/' || p_submission_id || '/cover.webp'
        AND v_cover.mime_type = 'image/webp')
      OR (v_cover.object_key IN (
          'submissions/' || p_submission_id || '/cover.jpg',
          'submissions/' || p_submission_id || '/cover.jpeg'
        ) AND v_cover.mime_type = 'image/jpeg')
    ) THEN
    RAISE EXCEPTION 'invalid published submission shape: %', p_submission_id
      USING ERRCODE = 'P1002';
  END IF;
END;
$$;

-- 迁移先只读盘点既有发布记录；任何坏记录都会回滚整份迁移且不改数据。
DO $publication_shape_inventory$
DECLARE
  v_submission_id text;
BEGIN
  FOR v_submission_id IN
    SELECT id FROM submissions WHERE status = 'published' ORDER BY id
  LOOP
    PERFORM assert_submission_publication_shape(v_submission_id);
  END LOOP;
END
$publication_shape_inventory$;

CREATE UNIQUE INDEX assets_one_cover_per_submission_idx
  ON assets (submission_id)
  WHERE role = 'cover';
CREATE UNIQUE INDEX assets_one_package_per_submission_idx
  ON assets (submission_id)
  WHERE role = 'package';

-- 两张表共用同一个薄触发器入口，规则本身仍只存在于结构断言中。
CREATE FUNCTION enforce_submission_publication_shape()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_TABLE_NAME = 'submissions' THEN
    PERFORM assert_submission_publication_shape(NEW.id);
  ELSE
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      PERFORM assert_submission_publication_shape(OLD.submission_id);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE')
      AND (TG_OP <> 'UPDATE'
        OR NEW.submission_id IS DISTINCT FROM OLD.submission_id) THEN
      PERFORM assert_submission_publication_shape(NEW.submission_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER submissions_publication_shape_guard
AFTER INSERT OR UPDATE ON submissions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_submission_publication_shape();

CREATE CONSTRAINT TRIGGER assets_publication_shape_guard
AFTER INSERT OR UPDATE OR DELETE ON assets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_submission_publication_shape();

REVOKE ALL ON FUNCTION assert_submission_publication_shape(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION enforce_submission_publication_shape()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION assert_submission_publication_shape(text)
  TO service_role;

COMMIT;
