import {
  createNextReviewRouteHandlers,
  createNextStreamingRouteHandlers,
  dynamic as nextDynamic,
  maxDuration as nextMaxDuration,
  runtime as nextRuntime,
} from '../../../next-app-router.js';
import { createNextAiSdkUiRoute } from '../../../next-ai-sdk-ui.js';

export const runtime = nextRuntime;
export const dynamic = nextDynamic;
export const maxDuration = nextMaxDuration;

export const reviewRoutes = createNextReviewRouteHandlers();
export const streamingRoutes = createNextStreamingRouteHandlers();
export const chatRoute = createNextAiSdkUiRoute();
