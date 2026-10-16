import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../errors.js";
import { requireApiKey } from "../services/auth.js";
import { consume } from "../services/consume.js";

const consumeBody = z.object({
  userId: z.string().min(1), // the user's externalId in the calling application
  units: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().min(1).max(200),
});

export async function consumeRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);

  // Both accepted and rejected decisions return 200; check `accepted` in the body
  app.post("/consume", async (req) => {
    const body = parseBody(consumeBody, req.body);
    return consume({
      accountId: req.account!.id,
      userExternalId: body.userId,
      units: body.units,
      requestId: body.requestId,
    });
  });
}
