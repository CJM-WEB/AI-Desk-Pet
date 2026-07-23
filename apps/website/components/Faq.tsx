const questions = [
  ['支持哪些系统？', '第一阶段目标是 Windows 10/11 x64。'],
  ['API Key 归谁管理？', 'API Key 来自你选择的兼容模型服务，本地客户端只保存加密后的密钥。'],
  ['它能访问所有文件吗？', '不能。它只处理你授权目录内的相对路径，不会越过授权目录。'],
  ['第一阶段不能做什么？', '不支持 Shell、删除、复制、移动、后台自动任务、账号同步或正式自动更新。']
];

export function Faq() {
  return (
    <section id="faq" className="section-block faq">
      <p className="section-kicker">边界说明</p>
      <h2>常见问题</h2>
      <div className="faq-list">
        {questions.map(([question, answer]) => (
          <article key={question}>
            <h3>{question}</h3>
            <p>{answer}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
