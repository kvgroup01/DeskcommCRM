/**
 * POST /api/v1/channel-sessions/[id]/groups/[groupId]/participants
 *
 *   { "action": "add",     "phones": ["+55 31 99999-0000"] }
 *   { "action": "remove" | "promote" | "demote", "participant_ids": ["5531…@c.us" | "…@lid"] }
 *
 * Responde quem o WhatsApp CONFIRMOU depois de reler o grupo, e quem não entrou
 * (privacidade do contato) ou não tem WhatsApp. Nada confirmado = 502. Só gerente
 * ou administrador.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { alterarParticipantes, TETO_DE_PARTICIPANTES } from "@/lib/grupos/gestao";
import { requireSupportWrite } from "@/lib/impersonate/support";

import {
  falhaDeGestao,
  prepararPedidoDeGrupo,
  telefoneDigitado,
  type ContextoDoGrupo,
} from "../../_comum";

export const dynamic = "force-dynamic";

const jids = z
  .array(z.string().regex(/^\d+@(c\.us|s\.whatsapp\.net|lid)$/))
  .min(1)
  .max(TETO_DE_PARTICIPANTES);

const corpoSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    phones: z.array(telefoneDigitado).min(1).max(TETO_DE_PARTICIPANTES),
  }),
  z.object({ action: z.literal("remove"), participant_ids: jids }),
  z.object({ action: z.literal("promote"), participant_ids: jids }),
  z.object({ action: z.literal("demote"), participant_ids: jids }),
]);

export async function POST(req: NextRequest, ctx: ContextoDoGrupo): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const p = await prepararPedidoDeGrupo(ctx);
  if (!p.ok) return p.response;
  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success)
    return fail("validation_error", "dados inválidos", 400, { requestId: p.requestId });
  try {
    const r =
      corpo.data.action === "add"
        ? await alterarParticipantes(p.deps, {
            ...p.alvo,
            ...p.ator,
            action: "add",
            phones: [...new Set(corpo.data.phones)],
          })
        : await alterarParticipantes(p.deps, {
            ...p.alvo,
            ...p.ator,
            action: corpo.data.action,
            participantIds: [...new Set(corpo.data.participant_ids)],
          });
    return ok(r, { requestId: p.requestId });
  } catch (err) {
    return falhaDeGestao(err, p.requestId);
  }
}
