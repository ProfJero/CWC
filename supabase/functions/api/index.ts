// Supabase Edge Function entry point. All logic lives in handler.ts (testable under Node).
import { handle } from './handler.ts';
import { envFromDeno } from './env.ts';

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (req: Request) => Response | Promise<Response>): void };

const env = envFromDeno((k) => Deno.env.get(k));
Deno.serve((req) => handle(req, env));
