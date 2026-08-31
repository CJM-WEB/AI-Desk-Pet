import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, type ApiClient } from '../lib/api-client';
import {
  CloudSharedPetRepository,
  type SignedUpload,
  uploadWithXhr
} from '../components/website-experience/community/cloud-shared-pet-repository';

const prepared = {
  submissionId: 'submission-1',
  statusToken: 'a'.repeat(43),
  statusPath: '/submission-status/' as const,
  status: 'uploading' as const,
  coverUpload: { url: 'https://storage.example/cover', expiresAt: '2026-08-01T00:00:00.000Z' },
  packageUpload: { url: 'https://storage.example/package', expiresAt: '2026-08-01T00:00:00.000Z' }
};

function createInput(zipType = 'application/zip') {
  return {
    name: '云端宠物',
    description: '等待审核的共享包',
    coverFile: new File(['cover'], 'cover.png', { type: 'image/png' }),
    packageFile: new File(['package'], 'pet.zip', { type: zipType })
  };
}

function createApi(...values: unknown[]) {
  return { request: vi.fn().mockResolvedValueOnce(values[0]).mockResolvedValueOnce(values[1]) } as unknown as ApiClient;
}

describe('云端共享仓库', () => {
  it('投稿接口只接收输入和可选进度回调', () => {
    expect(CloudSharedPetRepository.prototype.submit.length).toBe(2);
  });

  it('默认 XHR 上传设置 PUT、规范 MIME、真实进度并处理失败', async () => {
    class FakeRequest extends EventTarget {
      static last: FakeRequest | undefined;
      upload = new EventTarget();
      status = 0;
      method = '';
      url = '';
      body: Document | XMLHttpRequestBodyInit | null = null;
      readonly headers = new Map<string, string>();

      constructor() {
        super();
        FakeRequest.last = this;
      }

      open(method: string, url: string) { this.method = method; this.url = url; }
      setRequestHeader(name: string, value: string) { this.headers.set(name, value); }
      send(body: Document | XMLHttpRequestBodyInit | null) { this.body = body; }
    }
    vi.stubGlobal('XMLHttpRequest', FakeRequest as unknown as typeof XMLHttpRequest);
    try {
      const progress: number[] = [];
      const upload = uploadWithXhr('https://storage.example/package', createInput().packageFile, 'application/zip', loaded => progress.push(loaded));
      const request = FakeRequest.last!;
      request.upload.dispatchEvent(Object.assign(new Event('progress'), {
        lengthComputable: true, loaded: 3
      }));
      request.status = 204;
      request.dispatchEvent(new Event('load'));
      await expect(upload).resolves.toBeUndefined();
      expect(request).toMatchObject({ method: 'PUT', url: 'https://storage.example/package' });
      expect(request.headers.get('content-type')).toBe('application/zip');
      expect(progress).toEqual([3]);

      const failed = uploadWithXhr('https://storage.example/package', createInput().packageFile, 'application/zip', () => undefined);
      FakeRequest.last!.dispatchEvent(new Event('error'));
      await expect(failed).rejects.toThrow('UPLOAD_FAILED');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('投稿按准备、双文件直传和完成确认的顺序执行，并规范 ZIP MIME', async () => {
    const api = createApi(prepared, { status: 'system_reviewing' });
    const upload = vi.fn(async (_url, _file, _type, progress) => progress(_file.size)) as SignedUpload;
    const repository = new CloudSharedPetRepository(api, upload);

    const receipt = await repository.submit(createInput('application/x-zip-compressed'));

    expect(api.request).toHaveBeenNthCalledWith(1, '/submissions/prepare', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"contentType":"application/zip"')
    }));
    expect(JSON.parse(vi.mocked(api.request).mock.calls[0]![1]!.body as string)).not.toHaveProperty('captcha');
    expect(upload).toHaveBeenNthCalledWith(1, 'https://storage.example/cover', expect.any(File), 'image/png', expect.any(Function));
    expect(upload).toHaveBeenNthCalledWith(2, 'https://storage.example/package', expect.any(File), 'application/zip', expect.any(Function));
    expect(api.request).toHaveBeenNthCalledWith(2, '/submissions/submission-1/finalize', {
      method: 'POST', body: '{}'
    });
    expect(receipt.status).toBe('system_reviewing');
  });

  it('完成确认若伪造为直接人工审核则失败关闭', async () => {
    const api = createApi(prepared, { status: 'manual_review_pending' });
    const upload = vi.fn(async () => undefined) as SignedUpload;

    await expect(
      new CloudSharedPetRepository(api, upload).submit(createInput())
    ).rejects.toThrow('SUBMISSION_STATUS_INVALID');
  });

  it.each(['', 'application/x-zip-compressed'])('空或别名 ZIP MIME 仍以 application/zip 上传：%s', async zipType => {
    const api = createApi(prepared, { status: 'system_reviewing' });
    const upload = vi.fn(async () => undefined) as SignedUpload;
    await new CloudSharedPetRepository(api, upload).submit(createInput(zipType));
    expect(JSON.parse(vi.mocked(api.request).mock.calls[0]![1]!.body as string).packageFile.contentType)
      .toBe('application/zip');
    expect(vi.mocked(upload).mock.calls[1]![2]).toBe('application/zip');
  });

  it('聚合两个文件的真实已上传字节进度', async () => {
    const api = createApi(prepared, { status: 'system_reviewing' });
    const upload = vi.fn(async (_url, file, _type, progress) => {
      progress(Math.floor(file.size / 2));
      progress(file.size);
    }) as SignedUpload;
    const progress: number[] = [];
    await new CloudSharedPetRepository(api, upload).submit(createInput(), value => progress.push(value));
    expect(progress).toEqual([0, 16, 41, 66, 100]);
  });

  it('公开游标列表不伪造总页数或封面私有元数据', async () => {
    const request = vi.fn().mockResolvedValue({
      items: [{
        id: 'pet-1', name: '宠物', description: '描述',
        cover: { url: 'https://storage.example/cover?signature=secret', expiresAt: '2026-08-01T00:00:00.000Z' },
        packageFileName: 'pet.zip', packageSizeBytes: 7, likeCount: 1, downloadCount: 2,
        publishedAt: '2026-08-01T00:00:00.000Z', publicationBasis: 'admin_override'
      }], nextCursor: 8
    });
    const api = { request } as unknown as ApiClient;
    const page = await new CloudSharedPetRepository(api).listPage(1);
    expect(page).toMatchObject({ page: 1, totalKnown: false, hasNext: true });
    expect(page.items[0]).toMatchObject({
      coverUrl: 'https://storage.example/cover?signature=secret',
      publicationBasis: 'admin_override'
    });
    expect(page.items[0]?.coverFileName).toBeUndefined();
    expect(request).toHaveBeenCalledWith('/community?limit=8&cursor=0');
  });

  it('游标到达含条目的终页时公开精确总页数', async () => {
    const request = vi.fn().mockResolvedValue({
      items: [{
        id: 'pet-9', name: '宠物', description: '描述',
        cover: { url: 'https://storage.example/cover', expiresAt: '2026-08-01T00:00:00.000Z' },
        packageFileName: 'pet.zip', packageSizeBytes: 7, likeCount: 0, downloadCount: 0,
        publishedAt: '2026-08-01T00:00:00.000Z', publicationBasis: 'standard'
      }], nextCursor: null
    });
    const api = { request } as unknown as ApiClient;
    await expect(new CloudSharedPetRepository(api).listPage(2)).resolves.toMatchObject({
      total: 9, totalPages: 2, totalKnown: true, hasNext: false
    });
    expect(request).toHaveBeenCalledWith('/community?limit=8&cursor=8');
  });

  it('详情 404 返回 null，点赞和下载仅使用公开 API', async () => {
    const api = { request: vi.fn()
      .mockRejectedValueOnce(new ApiClientError('NOT_FOUND', 404))
      .mockResolvedValueOnce({
        id: 'pet-1', name: '宠物', description: '描述',
        cover: { url: 'https://storage.example/cover', expiresAt: '2026-08-01T00:00:00.000Z' },
        packageFileName: 'pet.zip', packageSizeBytes: 7, likeCount: 1, downloadCount: 2,
        publishedAt: '2026-08-01T00:00:00.000Z', publicationBasis: 'admin_override'
      })
      .mockResolvedValueOnce({ liked: true, likeCount: 2 })
      .mockResolvedValueOnce({
        url: 'https://storage.example/package',
        expiresAt: '2026-08-01T00:00:00.000Z',
        publicationBasis: 'admin_override'
      })
    } as unknown as ApiClient;
    const repository = new CloudSharedPetRepository(api);
    await expect(repository.getById('missing')).resolves.toBeNull();
    await repository.getById('pet-1');
    await expect(repository.toggleLike('pet-1')).resolves.toMatchObject({ likedByCurrentUser: true, likeCount: 2 });
    await expect(repository.getDownload('pet-1')).resolves.toEqual({
      url: 'https://storage.example/package', expiresAt: '2026-08-01T00:00:00.000Z',
      fileName: 'pet.zip', publicationBasis: 'admin_override'
    });
  });

  it.each([undefined, 'unsafe'])('公开列表对非法发布依据失败关闭：%s', async publicationBasis => {
    const request = vi.fn().mockResolvedValue({
      items: [{
        id: 'pet-invalid', name: '宠物', description: '描述',
        cover: { url: 'https://storage.example/cover', expiresAt: '2026-08-01T00:00:00.000Z' },
        packageFileName: 'pet.zip', packageSizeBytes: 7, likeCount: 0, downloadCount: 0,
        publishedAt: '2026-08-01T00:00:00.000Z', publicationBasis
      }],
      nextCursor: null
    });

    await expect(
      new CloudSharedPetRepository({ request } as unknown as ApiClient).listPage(1)
    ).rejects.toThrow();
  });

  it('封面上传失败时只请求 prepare 且不上传 ZIP', async () => {
    const api = createApi(prepared, { status: 'system_reviewing' });
    const upload = vi.fn(async () => { throw new Error('cover'); }) as SignedUpload;
    await expect(new CloudSharedPetRepository(api, upload).submit(createInput())).rejects.toThrow('cover');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(api.request).toHaveBeenCalledTimes(1);
  });

  it('ZIP 上传失败时不调用 finalize', async () => {
    const api = createApi(prepared, { status: 'system_reviewing' });
    let calls = 0;
    const upload = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error('package');
    }) as SignedUpload;
    await expect(new CloudSharedPetRepository(api, upload).submit(createInput())).rejects.toThrow('package');
    expect(upload).toHaveBeenCalledTimes(2);
    expect(api.request).toHaveBeenCalledTimes(1);
  });

  it('完成确认失败时保留两个已完成上传并传播错误', async () => {
    const api = { request: vi.fn()
      .mockResolvedValueOnce(prepared)
      .mockRejectedValueOnce(new Error('finalize'))
    } as unknown as ApiClient;
    const upload = vi.fn(async () => undefined) as SignedUpload;
    await expect(new CloudSharedPetRepository(api, upload).submit(createInput())).rejects.toThrow('finalize');
    expect(upload).toHaveBeenCalledTimes(2);
    expect(api.request).toHaveBeenCalledTimes(2);
  });
});
