import { describe, expect, it } from "vitest";

import { chatIdDoGrupo, lerDetalheDoGrupo, lerLinkDeConvite, lerParticipantes } from "./client";

describe("respostas de grupo do WAHA", () => {
  it("detalhe no formato NOWEB", () => {
    const d = lerDetalheDoGrupo(
      {
        id: "1203@g.us",
        subject: "Clientes",
        desc: "regras",
        announce: true,
        restrict: false,
        participants: [
          { id: "5531999990000@s.whatsapp.net", admin: "superadmin" },
          { id: "777@lid", admin: "admin" },
          { id: "5511888880000@s.whatsapp.net", admin: null },
        ],
      },
      "1203@g.us",
    );
    expect(d).toEqual({
      chatId: "1203@g.us",
      subject: "Clientes",
      description: "regras",
      onlyAdminsSend: true,
      onlyAdminsEditInfo: false,
      participants: [
        { id: "5531999990000@s.whatsapp.net", role: "superadmin" },
        { id: "777@lid", role: "admin" },
        { id: "5511888880000@s.whatsapp.net", role: "participant" },
      ],
    });
  });

  it("detalhe no formato WEBJS (groupMetadata e id serializado)", () => {
    const d = lerDetalheDoGrupo(
      {
        id: { _serialized: "1203@g.us" },
        name: "Clientes",
        groupMetadata: {
          desc: "regras",
          participants: [
            { id: { _serialized: "5531999990000@c.us" }, isAdmin: true, isSuperAdmin: false },
          ],
        },
      },
      "1203@g.us",
    );
    expect(d.subject).toBe("Clientes");
    expect(d.description).toBe("regras");
    expect(d.participants).toEqual([{ id: "5531999990000@c.us", role: "admin" }]);
    // Não veio → null, nunca um palpite de "desligado".
    expect(d.onlyAdminsSend).toBeNull();
  });

  it("participants/v2 normalizado, sem quem saiu", () => {
    expect(
      lerParticipantes([
        { id: "1@c.us", role: "participant" },
        { id: "2@c.us", role: "left" },
        { id: "3@lid", role: "superadmin" },
      ]),
    ).toEqual([
      { id: "1@c.us", role: "participant" },
      { id: "3@lid", role: "superadmin" },
    ]);
  });

  it("resposta que não é lista não inventa participante", () => {
    expect(lerParticipantes({ erro: true })).toEqual([]);
    expect(lerDetalheDoGrupo(null, "9@g.us").chatId).toBe("9@g.us");
  });

  it("id do grupo criado vem em id, gid ou serializado — e precisa ser @g.us", () => {
    expect(chatIdDoGrupo({ id: "1@g.us" })).toBe("1@g.us");
    expect(chatIdDoGrupo({ gid: { _serialized: "2@g.us" } })).toBe("2@g.us");
    expect(chatIdDoGrupo({ id: "5531@c.us" })).toBeNull();
  });

  it("link de convite a partir de texto, JSON com aspas ou objeto", () => {
    expect(lerLinkDeConvite("https://chat.whatsapp.com/AbC123")).toBe(
      "https://chat.whatsapp.com/AbC123",
    );
    expect(lerLinkDeConvite('"AbC123"')).toBe("https://chat.whatsapp.com/AbC123");
    expect(lerLinkDeConvite({ inviteCode: "AbC123" })).toBe("https://chat.whatsapp.com/AbC123");
    expect(lerLinkDeConvite("")).toBeNull();
    expect(lerLinkDeConvite("<html>erro</html>")).toBeNull();
  });
});
