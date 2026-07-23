const steps = [
  ['配置兼容模型', '填入 Base URL、模型名和 API Key，由本地客户端保存配置。'],
  ['授权一个工作目录', '通过系统目录选择器选择测试目录，桌宠只在该目录内工作。'],
  ['确认写操作', '新建或重命名前先展示预览，你确认后才会真正写入。']
];

export function HowItWorks() {
  return (
    <section id="workflow" className="section-block workflow">
      <p className="section-kicker">工作方式</p>
      <h2>三步开始使用</h2>
      <ol className="step-list">
        {steps.map(([title, text], index) => (
          <li key={title}>
            <span className="step-index">{index + 1}</span>
            <div>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
