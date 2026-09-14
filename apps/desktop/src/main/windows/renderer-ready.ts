/** 只在自有页面观察首个视图提交，避免懒加载时先显示空白窗口。 */
function waitForRoot(): Promise<void> {
  return new Promise((resolve, reject) => {
    const hasView = () => Boolean(document.getElementById('root')?.firstElementChild);
    if (hasView()) {
      resolve();
      return;
    }
    const observer = new MutationObserver(() => {
      if (!hasView()) return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve();
    });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error('RENDERER_READY_TIMEOUT'));
    }, 10_000);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  });
}

/** 固定脚本不读取正文或配置；上下文销毁和超时由原窗口加载事务处理。 */
export async function waitForRendererReady(contents: {
  executeJavaScript(code: string): Promise<unknown>;
}): Promise<void> {
  await contents.executeJavaScript(`(${waitForRoot.toString()})()`);
}
