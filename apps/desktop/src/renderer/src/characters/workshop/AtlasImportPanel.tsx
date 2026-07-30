import { useEffect, useState } from 'react';
import type { ImportedWorkshopSource } from '../store/character-workshop-store';

export interface AtlasImportPanelProps {
  sources: ImportedWorkshopSource[];
  disabled: boolean;
  onApply(input: {
    sourceAssetId: string;
    rows: number;
    columns: number;
    frameCount: number;
  }): Promise<void>;
}

/** 把已授权导入的单张精灵图配置为当前动作的行列与有效帧。 */
export function AtlasImportPanel(props: AtlasImportPanelProps) {
  const [sourceAssetId, setSourceAssetId] = useState('');
  const [rows, setRows] = useState(1);
  const [columns, setColumns] = useState(1);
  const [frameCount, setFrameCount] = useState(1);

  useEffect(() => {
    if (!props.sources.some(source => source.assetId === sourceAssetId)) {
      setSourceAssetId(props.sources[0]?.assetId ?? '');
    }
  }, [props.sources, sourceAssetId]);

  return (
    <section className="atlas-import-panel" aria-labelledby="atlas-import-heading">
      <div className="section-heading">
        <h2 id="atlas-import-heading">精灵图网格</h2>
      </div>
      {props.sources.length === 0 ? (
        <p className="workshop-empty">先使用顶部“导入素材”选择 PNG 或 WebP。</p>
      ) : (
        <form onSubmit={event => {
          event.preventDefault();
          void props.onApply({ sourceAssetId, rows, columns, frameCount });
        }}>
          <label>
            已导入素材
            <select
              aria-label="已导入素材"
              value={sourceAssetId}
              disabled={props.disabled}
              onChange={event => setSourceAssetId(event.currentTarget.value)}
            >
              {props.sources.map(source => (
                <option key={source.assetId} value={source.assetId}>
                  {source.displayName}
                </option>
              ))}
            </select>
          </label>
          <div className="property-grid">
            <label>
              行数
              <input
                type="number"
                min="1"
                max="64"
                value={rows}
                disabled={props.disabled}
                onChange={event => setRows(Number(event.currentTarget.value))}
              />
            </label>
            <label>
              列数
              <input
                type="number"
                min="1"
                max="64"
                value={columns}
                disabled={props.disabled}
                onChange={event => setColumns(Number(event.currentTarget.value))}
              />
            </label>
          </div>
          <label>
            有效帧数
            <input
              type="number"
              min="1"
              max={Math.max(1, rows * columns)}
              value={frameCount}
              disabled={props.disabled}
              onChange={event => setFrameCount(Number(event.currentTarget.value))}
            />
          </label>
          <button
            className="primary-command"
            type="submit"
            disabled={props.disabled || !sourceAssetId}
          >
            应用到当前动作
          </button>
        </form>
      )}
    </section>
  );
}
