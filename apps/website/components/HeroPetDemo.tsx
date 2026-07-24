export function HeroPetDemo() {
  return (
    <div className="pet-demo" aria-label="桌宠确认文件操作演示">
      <div className="demo-window">
        <div className="demo-title">授权目录</div>
        <div className="demo-row active">notes.md</div>
        <div className="demo-row">ideas</div>
        <div className="demo-row muted">archive.txt</div>
      </div>
      <div className="demo-bubble">
        <strong>帮我新建 notes.md</strong>
        <span>等待确认 · 不会覆盖已有文件</span>
      </div>
      <div className="demo-pet" aria-hidden="true">
        <span className="pet-ear left" />
        <span className="pet-ear right" />
        <span className="pet-face">
          <span className="pet-eye left" />
          <span className="pet-eye right" />
          <span className="pet-mouth" />
        </span>
      </div>
    </div>
  );
}
