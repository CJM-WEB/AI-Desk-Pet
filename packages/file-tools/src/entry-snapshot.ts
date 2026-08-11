/** 公开快照只描述授权根内相对实体，不包含文件系统身份或正文哈希。 */
export type EntrySnapshot = Readonly<{
  relativePath: string;
  type: 'file' | 'directory';
  size: number | null;
}>;

/** 目标期望用于确认卡摘要；真实身份约束保存在服务私有签发记录中。 */
export type EntryExpectation = Readonly<{
  relativePath: string;
  state: 'absent' | 'existing';
}>;

export function freezeEntrySnapshot(snapshot: EntrySnapshot): EntrySnapshot {
  return Object.freeze({ ...snapshot });
}

export function freezeEntryExpectation(expectation: EntryExpectation): EntryExpectation {
  return Object.freeze({ ...expectation });
}
