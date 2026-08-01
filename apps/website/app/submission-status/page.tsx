'use client';

import { ApiClient } from '../../lib/api-client';
import { SubmissionStatusPage } from './submission-status-page';

const productionApi = new ApiClient(
  process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api/v1'
);

export default function Page() {
  return <SubmissionStatusPage api={productionApi} />;
}
