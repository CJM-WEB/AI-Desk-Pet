import { describe, expect, it, vi } from 'vitest';
import { CloudSharedPetRepository } from '../components/website-experience/community/cloud-shared-pet-repository';
import type { ApiClient } from '../lib/api-client';
import type { CaptchaProof } from '@myself/shared-types';

const captcha: CaptchaProof = { ticket: 'captcha-ticket', randstr: 'captcha-randstr' };

function createInput() {
  return {
    name: '云端宠物',
    description: '等待审核的共享包',
    coverFile: new File(['cover'], 'cover.png', { type: 'image/png' }),
    packageFile: new File(['package'], 'pet.zip', { type: 'application/zip' })
  };
}

describe('云端共享仓库', () => {
  it('投稿按准备、双文件直传和完成确认的顺序执行', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        submissionId: 'submission-1',
        statusToken: 'a'.repeat(43),
        statusPath: '/submission-status/',
        status: 'uploading',
        coverUpload: { url: 'https://storage.example/cover', expiresAt: '2026-08-01T00:00:00.000Z' },
        packageUpload: { url: 'https://storage.example/package', expiresAt: '2026-08-01T00:00:00.000Z' }
      })
      .mockResolvedValueOnce({ status: 'system_reviewing' });
    const upload = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const repository = new CloudSharedPetRepository({ request } as unknown as ApiClient, upload);

    const receipt = await repository.submit(createInput(), captcha);

    expect(request).toHaveBeenNthCalledWith(1, '/submissions/prepare', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        kind: 'shared_package',
        title: '云端宠物',
        body: '等待审核的共享包',
        captcha,
        coverFile: { fileName: 'cover.png', sizeBytes: 5, contentType: 'image/png' },
        packageFile: { fileName: 'pet.zip', sizeBytes: 7, contentType: 'application/zip' }
      })
    }));
    expect(upload).toHaveBeenNthCalledWith(1, 'https://storage.example/cover', expect.objectContaining({
      method: 'PUT', body: expect.any(File)
    }));
    expect(upload).toHaveBeenNthCalledWith(2, 'https://storage.example/package', expect.objectContaining({
      method: 'PUT', body: expect.any(File)
    }));
    expect(request).toHaveBeenNthCalledWith(2, '/submissions/submission-1/finalize', {
      method: 'POST',
      body: '{}'
    });
    expect(receipt).toEqual({
      submissionId: 'submission-1',
      statusToken: 'a'.repeat(43),
      statusPath: '/submission-status/',
      status: 'system_reviewing'
    });
  });
});
