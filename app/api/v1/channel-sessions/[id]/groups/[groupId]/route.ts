/**
 * GET   /api/v1/channel-sessions/[id]/groups/[groupId] — participantes, descrição e travas do grupo.
 * PATCH — nome, descrição e travas ("só admins enviam", "só admins editam os dados").
 *
 * `[groupId]` é o id do grupo sem o `@g.us`. Só gerente ou administrador.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { atualizarDados, lerGrupo } from "@/lib/grupos/gestao";
import { requireSupportWrite } from "@/lib/impersonate/support";

import { falhaDeGestao, prepararPedidoDeGrupo, type ContextoDoGrupo } from "../_comum";

export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    subject: z.string().trim().min(1).max(100).optional(),
    // 2048 é o limite do WhatsApp para a descrição; vazio apaga.
    description: z.string().max(2048).optional(),
    only_admins_send: z.boolean().optional(),
    only_admins_edit_info: z.boolean().optional(),
  })
  .refine((c) => Object.values(c).some((v) => v !== undefined), { message: "nada a mudar" });

export async function GET(_req: NextRequest, ctx: ContextoDoGrupo): Promise<Response> {
  const p = await prepararPedidoDeGrupo(ctx);
  if (!p.ok) return p.response;
  try {
    return ok(await lerGrupo(p.deps, p.alvo), { requestId: p.requestId });
  } catch (err) {
    return falhaDeGestao(err, p.requestId);
  }
}

export async function PATCH(req: NextRequest, ctx: ContextoDoGrupo): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const p = await prepararPedidoDeGrupo(ctx);
  if (!p.ok) return p.response;
  const corpo = patchSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success)
    return fail("validation_error", "dados inválidos", 400, { requestId: p.requestId });
  try {
    const r = await atualizarDados(p.deps, {
      ...p.alvo,
      ...p.ator,
      subject: corpo.data.subject,
      description: corpo.data.description,
      onlyAdminsSend: corpo.data.only_admins_send,
      onlyAdminsEditInfo: corpo.data.only_admins_edit_info,
    });
    return ok(r, { requestId: p.requestId });
  } catch (err) {
    return falhaDeGestao(err, p.requestId);
  }
}
