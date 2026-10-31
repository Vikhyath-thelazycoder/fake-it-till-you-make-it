import { buildApp } from "@/server/app";

// Express answers every /api call, as one Vercel function.
export const config = { api: { bodyParser: false, externalResolver: true } };

export default buildApp();
