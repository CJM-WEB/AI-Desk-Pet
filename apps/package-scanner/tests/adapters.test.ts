import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  ClamAvCommandScanner,
  createTencentImsClient,
  TencentImageContentModerator
} from '../src/server';
import { ONE_PIXEL_PNG } from './zip-fixture';

class HangingChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

describe('外部扫描适配器超时', () => {
  it('腾讯 IMS 客户端要求显式凭据并透传临时令牌', () => {
    expect(() => createTencentImsClient({
      TENCENT_CLOUD_REGION: 'ap-shanghai',
      TENCENTCLOUD_SECRETID: '',
      TENCENTCLOUD_SECRETKEY: 'secret-key'
    }, class {} as never)).toThrow('TENCENTCLOUD_SECRETID');

    let received: unknown;
    class TestClient {
      constructor(options: unknown) {
        received = options;
      }
    }
    createTencentImsClient({
      TENCENT_CLOUD_REGION: 'ap-shanghai',
      TENCENTCLOUD_SECRETID: 'secret-id',
      TENCENTCLOUD_SECRETKEY: 'secret-key',
      TENCENTCLOUD_SESSIONTOKEN: 'session-token'
    }, TestClient as never);
    expect(received).toMatchObject({
      credential: {
        secretId: 'secret-id',
        secretKey: 'secret-key',
        token: 'session-token'
      },
      profile: { httpProfile: { reqTimeout: 15 } }
    });
  });

  it('ClamAV 超时后强制终止子进程并返回稳定错误', async () => {
    const child = new HangingChildProcess();
    const scanner = new ClamAvCommandScanner(
      'clamscan',
      5,
      () => child as never
    );

    await expect(scanner.scan({
      path: 'compiled/idle.png',
      bytes: ONE_PIXEL_PNG
    })).rejects.toThrow('SCANNER_CLAMAV_UNAVAILABLE');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('整包取消时立即终止当前 ClamAV 子进程', async () => {
    const child = new HangingChildProcess();
    const controller = new AbortController();
    const scanner = new ClamAvCommandScanner(
      'clamscan',
      1_000,
      () => child as never
    );
    const operation = scanner.scan({
      path: 'compiled/idle.png',
      bytes: ONE_PIXEL_PNG,
      signal: controller.signal
    });
    controller.abort();

    await expect(Promise.race([
      operation,
      delay(100).then(() => {
        throw new Error('测试等待 ClamAV 取消失败');
      })
    ])).rejects.toThrow('SCANNER_SCAN_TIMEOUT');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('腾讯 IMS 挂起时在受控时间内返回稳定错误', async () => {
    const moderator = new TencentImageContentModerator({
      ImageModeration: async () => new Promise(() => undefined)
    } as never, undefined, 5);

    await expect(Promise.race([
      moderator.review({
        path: 'compiled/idle.png',
        bytes: ONE_PIXEL_PNG,
        mime: 'image/png'
      }),
      delay(100).then(() => {
        throw new Error('测试等待 IMS 超时保护失败');
      })
    ])).rejects.toThrow('SCANNER_IMAGE_MODERATION_UNAVAILABLE');
  });

  it('整包取消时立即停止等待腾讯 IMS', async () => {
    const controller = new AbortController();
    const moderator = new TencentImageContentModerator({
      ImageModeration: async () => new Promise(() => undefined)
    } as never, undefined, 1_000);
    const operation = moderator.review({
      path: 'compiled/idle.png',
      bytes: ONE_PIXEL_PNG,
      mime: 'image/png',
      signal: controller.signal
    });
    controller.abort();

    await expect(Promise.race([
      operation,
      delay(100).then(() => {
        throw new Error('测试等待 IMS 取消失败');
      })
    ])).rejects.toThrow('SCANNER_SCAN_TIMEOUT');
  });
});
