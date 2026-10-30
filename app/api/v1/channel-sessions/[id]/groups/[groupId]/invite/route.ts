/**
 * GET    /api/v1/channel-sessions/[id]/groups/[groupId]/invite — o link de convite do grupo.
 * DELETE — revoga o link atual; quem tinha o antigo deixa de entrar. Devolve o novo.
 *
 * Só gerente ou administrador: o link é uma porta de entrada no grupo.
 */
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { linkDeConvite, revogarConvite } from "@/lib/grupos/gestao";
import { requireSupportWrite } from "@/lib/impersonate/support";

import { falhaDeGestao, prepararPedidoDeGrupo, type ContextoDoGrupo } from "../../_comum";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: ContextoDoGrupo): Promise<Response> {
  const p = await prepararPedidoDeGrupo(ctx);
  if (!p.ok) return p.response;
  try {
    return ok(await linkDeConvite(p.deps, p.alvo), { requestId: p.requestId });
  } catch (err) {
    return falhaDeGestao(err, p.requestId);
  }
}

export async function DELETE(_req: NextRequest, ctx: ContextoDoGrupo): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const p = await prepararPedidoDeGrupo(ctx);
  if (!p.ok) return p.response;
  try {
    return ok(await revogarConvite(p.deps, { ...p.alvo, ...p.ator }), { requestId: p.requestId });
  } catch (err) {
    return falhaDeGestao(err, p.requestId);
  }
}
