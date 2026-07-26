// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen
} from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';
import { DonationChapter } from '../components/website-experience/donation/DonationChapter';

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? '';
  }
}

function openWechatDialog() {
  const trigger = screen.getByRole('button', { name: '打开微信付款码' });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

describe('捐款章节', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      value: TestPointerEvent
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('静态渲染标题、配置支付方式和局部输入区域', () => {
    const html = renderToStaticMarkup(<DonationChapter interactive />);

    expect(html).toContain('data-testid="donation-chapter"');
    expect(html).toContain('助力开发，你便也是我不可或缺的参与者');
    expect(html).toContain('微信');
    expect(html).toContain('支付宝');
    expect(html).toContain('data-input-scope="local"');
  });

  it('滚轮阻止默认与冒泡并按方向循环付款方式', () => {
    render(<DonationChapter interactive />);
    const roller = screen.getByRole('group', { name: '选择付款方式' });
    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 120
    });
    const preventDefault = vi.spyOn(wheel, 'preventDefault');
    const stopPropagation = vi.spyOn(wheel, 'stopPropagation');

    fireEvent(roller, wheel);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('button', { name: '打开支付宝付款码' })
        .getAttribute('aria-pressed')
    ).toBe('true');
  });

  it('方向键切换付款方式且 Escape 退出局部焦点', () => {
    render(<DonationChapter interactive />);
    const roller = screen.getByRole('group', { name: '选择付款方式' });
    roller.focus();

    fireEvent.keyDown(roller, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: '打开支付宝付款码' })).toBeTruthy();

    fireEvent.keyDown(roller, { key: 'ArrowUp' });
    expect(screen.getByRole('button', { name: '打开微信付款码' })).toBeTruthy();

    fireEvent.keyDown(roller, { key: 'Escape' });
    expect(document.activeElement).not.toBe(roller);
  });

  it('支付按钮聚焦后 Escape 退出局部输入且不冒泡到外层', () => {
    const outerKeyDown = vi.fn();
    render(
      <div onKeyDown={outerKeyDown}>
        <DonationChapter interactive />
      </div>
    );
    const paymentButton = screen.getByRole('button', {
      name: '打开微信付款码'
    });
    paymentButton.focus();

    fireEvent.keyDown(paymentButton, { key: 'Escape' });

    expect(document.activeElement).not.toBe(paymentButton);
    expect(outerKeyDown).not.toHaveBeenCalled();
  });

  it('触屏拖动超过阈值只响应首个 pointerId 并只切换一次', () => {
    render(<DonationChapter interactive />);
    const roller = screen.getByRole('group', { name: '选择付款方式' });

    fireEvent.pointerDown(roller, {
      clientY: 200,
      pointerId: 7,
      pointerType: 'touch'
    });
    fireEvent.pointerDown(roller, {
      clientY: 100,
      pointerId: 8,
      pointerType: 'touch'
    });
    fireEvent.pointerMove(roller, {
      clientY: 159,
      pointerId: 7,
      pointerType: 'touch'
    });
    fireEvent.pointerMove(roller, {
      clientY: 40,
      pointerId: 7,
      pointerType: 'touch'
    });

    expect(screen.getByRole('button', { name: '打开支付宝付款码' })).toBeTruthy();

    fireEvent.pointerUp(roller, {
      clientY: 40,
      pointerId: 7,
      pointerType: 'touch'
    });
    fireEvent.pointerMove(roller, {
      clientY: 0,
      pointerId: 8,
      pointerType: 'touch'
    });
    expect(screen.getByRole('button', { name: '打开支付宝付款码' })).toBeTruthy();
  });

  it('pointercancel 清除当前拖动并允许后续新手势', () => {
    render(<DonationChapter interactive />);
    const roller = screen.getByRole('group', { name: '选择付款方式' });

    fireEvent.pointerDown(roller, {
      clientY: 200,
      pointerId: 11,
      pointerType: 'touch'
    });
    fireEvent.pointerCancel(roller, {
      clientY: 180,
      pointerId: 11,
      pointerType: 'touch'
    });
    fireEvent.pointerMove(roller, {
      clientY: 80,
      pointerId: 11,
      pointerType: 'touch'
    });
    expect(screen.getByRole('button', { name: '打开微信付款码' })).toBeTruthy();

    fireEvent.pointerDown(roller, {
      clientY: 200,
      pointerId: 12,
      pointerType: 'touch'
    });
    fireEvent.pointerMove(roller, {
      clientY: 159,
      pointerId: 12,
      pointerType: 'touch'
    });
    expect(screen.getByRole('button', { name: '打开支付宝付款码' })).toBeTruthy();
  });

  it('拖动切换后忽略原卡片收到的合成点击', () => {
    render(<DonationChapter interactive />);
    const roller = screen.getByRole('group', { name: '选择付款方式' });
    const originalCard = screen.getByRole('button', { name: '打开微信付款码' });

    fireEvent.pointerDown(originalCard, {
      clientY: 200,
      pointerId: 15,
      pointerType: 'touch'
    });
    fireEvent.pointerMove(roller, {
      clientY: 150,
      pointerId: 15,
      pointerType: 'touch'
    });
    fireEvent.pointerUp(roller, {
      clientY: 150,
      pointerId: 15,
      pointerType: 'touch'
    });
    fireEvent.click(originalCard);

    expect(screen.getByRole('button', { name: '打开支付宝付款码' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('非当前卡片首次点击只切换，当前卡片再次点击才打开弹层', () => {
    render(<DonationChapter interactive />);

    fireEvent.click(screen.getByRole('button', { name: '选择支付宝付款方式' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '打开支付宝付款码' }));
    expect(screen.getByRole('dialog', { name: '支付宝付款码' })).toBeTruthy();
  });

  it('弹层立即保持打开，限制焦点，并在 Escape 后恢复触发按钮焦点', () => {
    render(<DonationChapter interactive />);
    const trigger = openWechatDialog();
    const dialog = screen.getByRole('dialog', { name: '微信付款码' });
    const closeButton = screen.getByRole('button', { name: '关闭付款码' });

    expect(dialog).toBeTruthy();
    expect(document.activeElement).toBe(closeButton);

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(closeButton);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('弹层根节点隔离章节滚轮、翻页键、方向键与触屏手势', () => {
    const windowWheel = vi.fn();
    const windowKeyDown = vi.fn();
    const windowPointerDown = vi.fn();
    window.addEventListener('wheel', windowWheel);
    window.addEventListener('keydown', windowKeyDown);
    window.addEventListener('pointerdown', windowPointerDown);

    render(<DonationChapter interactive />);
    openWechatDialog();
    const dialog = screen.getByRole('dialog', { name: '微信付款码' });
    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 120
    });
    const preventDefault = vi.spyOn(wheel, 'preventDefault');
    const stopPropagation = vi.spyOn(wheel, 'stopPropagation');

    expect(dialog.dataset.inputScope).toBe('local');
    fireEvent(dialog, wheel);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(windowWheel).not.toHaveBeenCalled();

    for (const key of [
      'PageUp',
      'PageDown',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight'
    ]) {
      fireEvent.keyDown(dialog, { key });
    }
    expect(windowKeyDown).not.toHaveBeenCalled();

    fireEvent.pointerDown(dialog, {
      clientY: 500,
      pointerId: 31,
      pointerType: 'touch'
    });
    expect(windowPointerDown).not.toHaveBeenCalled();

    window.removeEventListener('wheel', windowWheel);
    window.removeEventListener('keydown', windowKeyDown);
    window.removeEventListener('pointerdown', windowPointerDown);
  });

  it('弹层任意区域点击均关闭，付款码加载失败显示稳定回退', () => {
    const { rerender } = render(<DonationChapter interactive />);
    openWechatDialog();

    fireEvent.error(screen.getByRole('img', { name: '微信付款码' }));
    expect(screen.getByRole('status').textContent).toBe('付款码暂未配置');

    fireEvent.click(screen.getByTestId('qr-panel'));
    expect(screen.queryByRole('dialog')).toBeNull();

    rerender(<DonationChapter interactive />);
    openWechatDialog();
    fireEvent.click(screen.getByRole('dialog', { name: '微信付款码' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('interactive=false 时移出制表顺序且所有内部输入均不改变状态', () => {
    render(<DonationChapter interactive={false} />);
    const roller = screen.getByRole('group', { name: '选择付款方式' });
    const buttons = screen.getAllByRole('button');

    expect(roller.tabIndex).toBe(-1);
    expect(buttons.every((button) => button.tabIndex === -1)).toBe(true);

    fireEvent.wheel(roller, { deltaY: 120 });
    fireEvent.keyDown(roller, { key: 'ArrowDown' });
    fireEvent.pointerDown(roller, {
      clientY: 200,
      pointerId: 20,
      pointerType: 'touch'
    });
    fireEvent.pointerMove(roller, {
      clientY: 100,
      pointerId: 20,
      pointerType: 'touch'
    });
    fireEvent.click(screen.getByRole('button', { name: '选择支付宝付款方式' }));

    expect(screen.getByRole('button', { name: '打开微信付款码' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
