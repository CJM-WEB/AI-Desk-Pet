const safetyItems = [
  '模型不能运行 Shell，也不能要求客户端执行任意命令。',
  '文件工具不会越过授权目录，危险路径会被本地策略拒绝。',
  '写操作必须确认，取消后文件系统保持不变。',
  'API Key 不返回 Renderer，日志不记录密钥和文件正文。'
];

export function SafetySection() {
  return (
    <section id="safety" className="safety-section">
      <div>
        <p className="section-kicker">本地控制</p>
        <h2>文件安全由本地控制</h2>
        <p>
          Myself 第一阶段只开放列目录、读取文本、新建文件、新建目录和同目录重命名。模型提出的动作必须先经过本地校验。
        </p>
      </div>
      <ul className="safety-list">
        {safetyItems.map(item => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
