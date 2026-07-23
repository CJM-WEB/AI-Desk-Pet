const features = [
  ['桌宠交互', '角色状态会跟随聆听、思考、执行与结果变化，让桌面任务有明确反馈。'],
  ['模型由你选择', '填写自己的兼容模型地址、模型名和 API Key，第一阶段不绑定单一供应商。'],
  ['文件权限可控', '只在你授权的目录中工作，写操作先预览确认，已有目标不会被覆盖。']
];

export function FeatureGrid() {
  return (
    <section id="features" className="section-block">
      <p className="section-kicker">核心能力</p>
      <h2>它能做什么</h2>
      <div className="feature-grid">
        {features.map(([title, text]) => (
          <article className="feature-card" key={title}>
            <h3>{title}</h3>
            <p>{text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
