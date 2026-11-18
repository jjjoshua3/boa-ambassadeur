import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import zxcvbn from "zxcvbn";

const URL = process.env.SUPABASE_URL || "https://ofzyqwpztohflxdhqgbb.supabase.co";
const SLEUTEL = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SITE = "https://ambassadeur.boaportaal.nl";

function antwoord(status, data) {
  return {
    statusCode: status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(data),
  };
}

function lees(event) {
  try { return JSON.parse(event.body || "{}"); }
  catch { return {}; }
}

function sb() {
  if (!SLEUTEL) return null;
  return createClient(URL, SLEUTEL, { auth: { persistSession: false, autoRefreshToken: false } });
}

function stuk(waarde) {
  return String(waarde || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function mailLocal(voor, achter) {
  const a = stuk(voor);
  const b = stuk(achter);
  if (a.length < 2 || b.length < 2) return "";
  return `${a}.${b}`.slice(0, 64);
}

function token() {
  return randomBytes(24).toString("base64url");
}

function wachtwoordFout(password, extra = []) {
  const tekst = String(password || "");
  if (tekst.length < 12) return "Kies een wachtwoord van minstens 12 tekens.";
  const score = zxcvbn(tekst, extra.map((deel) => String(deel || "")).filter((deel) => deel.length > 1));
  const dagen = Math.floor(Number(score?.crack_times_seconds?.offline_fast_hashing_1e10_per_second || 0) / 86400);
  if (dagen < 30) return `Dit wachtwoord is te makkelijk voor de mailserver. Die eist minstens 30 dagen kraaktijd. Dit wachtwoord zit op ${dagen} dagen. Gebruik een lange zin van minstens vier willekeurige woorden.`;
  return "";
}

function geheim() {
  const tekens = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const extra = "!#";
  let uit = "A1!";
  const buf = randomBytes(18);
  for (const byte of buf) uit += tekens[byte % tekens.length];
  return (uit + extra).slice(0, 20);
}

function schoon(waarde, max) {
  return String(waarde || "").replace(/[\r\n<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function mailOk(email) {
  const adres = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adres)) return "";
  const domein = adres.split("@")[1];
  const gratis = ["gmail.com", "hotmail.com", "outlook.com", "live.nl", "icloud.com", "yahoo.com", "kpnmail.nl"];
  if (gratis.includes(domein)) return "";
  return adres;
}

async function wie(event, client) {
  const kop = event.headers?.authorization || event.headers?.Authorization || "";
  const jwt = kop.replace(/^Bearer\s+/i, "");
  if (jwt.length < 20) return null;
  const { data, error } = await client.auth.getUser(jwt);
  if (error || !data.user) return null;
  const { data: beheer } = await client.from("boa_ambassadeur").select("id, organisatie_id, voornaam, achternaam, email, mail_local, actief").eq("user_id", data.user.id).eq("actief", true).maybeSingle();
  if (!beheer) return null;
  const { data: org } = await client.from("boa_organisatie").select("id, naam, slug, domein").eq("id", beheer.organisatie_id).maybeSingle();
  if (!org) return null;
  return { user: data.user, beheer, org };
}

async function postbus({ local, password, domain }) {
  const tokenApi = process.env.PURELYMAIL_API_TOKEN || "";
  const naam = String(local || "").trim().toLowerCase();
  const domein = domain || "boaportaal.nl";
  const adres = `${naam}@${domein}`;
  if (!tokenApi) return { ok: false, fout: "PURELYMAIL_API_TOKEN ontbreekt. Maak de postbus handmatig aan." };
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(naam)) return { ok: false, fout: "Die postbusnaam kan niet als mailadres." };
  const headers = { "Content-Type": "application/json", "Purelymail-Api-Token": tokenApi };
  const res = await fetch("https://purelymail.com/api/v0/createUser", {
    method: "POST",
    headers,
    body: JSON.stringify({ userName: naam, domainName: domein, password, enablePasswordReset: false, sendWelcomeEmail: false }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, adres };
  const tekst = JSON.stringify(data);
  if (/exist|already/i.test(tekst)) {
    const wijzig = await fetch("https://purelymail.com/api/v0/modifyUser", {
      method: "POST",
      headers,
      body: JSON.stringify({ userName: adres, newPassword: password, enablePasswordReset: false }),
    });
    if (wijzig.ok) return { ok: true, adres };
    const fout = await wijzig.json().catch(() => ({}));
    return { ok: false, fout: fout?.message || "De postbus bestond al en het wachtwoord is niet gezet." };
  }
  return { ok: false, fout: data?.message || data?.code || "Postbus niet aangemaakt." };
}

async function verstuur({ van, passEnv, naar, onderwerp, tekst, html }) {
  const pass = process.env[passEnv] || "";
  if (!pass) return { ok: false, fout: `${passEnv} ontbreekt op de Netlify-site.` };
  const { default: nodemailer } = await import("nodemailer");
  const smtp = nodemailer.createTransport({ host: "smtp.purelymail.com", port: 465, secure: true, auth: { user: van, pass } });
  await smtp.sendMail({ from: { name: "BOA Portaal", address: van }, to: naar, subject: onderwerp, text: tekst, html });
  return { ok: true };
}

function briefUitnodiging({ voornaam, org, link, beheerder }) {
  const aanhef = `Beste ${voornaam},`;
  const extra = beheerder
    ? `U wordt beheerder van ${org} op ambassadeur.boaportaal.nl. Uw postbus wordt voornaam.achternaam@ambassadeur.boaportaal.nl. Daarmee logt u in op mail.boaportaal.nl, met het volledige adres.`
    : "Daarna logt u in op https://boaportaal.nl.";
  const tekst = [
    aanhef,
    "",
    `U bent door uw werkgever toegevoegd voor BOA Portaal.`,
    `Organisatie: ${org}.`,
    "",
    "Bevestig uw account binnen 14 dagen. Daarna vervalt deze uitnodiging.",
    link,
    "",
    "Op die pagina kiest u een wachtwoord en stelt u de tweestapsverificatie in.",
    extra,
    "",
    "Heeft u al een account op boaportaal.nl, dan koppelt u dat zelf. Uw werkgever ziet u pas nadat u dat bevestigt.",
    "",
    "Groet,",
    "BOA Portaal",
  ].join("\n");
  const html = `<div style="font-family:Segoe UI,Trebuchet MS,sans-serif;font-size:16px;line-height:1.55;color:#0f172a;max-width:560px">
    <p style="margin:0 0 12px;letter-spacing:.08em;font-size:12px;color:#1d4ed8">BOA PORTAAL</p>
    <h1 style="font-size:22px;margin:0 0 12px">Uitnodiging</h1>
    <p>${aanhef}</p>
    <p>U bent door uw werkgever toegevoegd voor BOA Portaal.<br>Organisatie: <b>${org}</b>.</p>
    <p>Bevestig uw account binnen 14 dagen. Daarna vervalt deze uitnodiging.</p>
    <p><a href="${link}" style="display:inline-block;background:#0F2537;color:#fff;text-decoration:none;padding:10px 16px">Account bevestigen</a></p>
    <p>Op die pagina kiest u een wachtwoord en stelt u de tweestapsverificatie in. ${extra}</p>
    <p>Heeft u al een account op boaportaal.nl, dan koppelt u dat zelf. Uw werkgever ziet u pas nadat u dat bevestigt.</p>
    <p>Groet,<br>BOA Portaal</p>
  </div>`;
  return { tekst, html };
}

async function logWerkgever(client, ctx, doel, reden) {
  await client.from("boa_audit").insert({
    beheerder_id: ctx.beheer.mail_local,
    beheerder_naam: `${ctx.beheer.voornaam} ${ctx.beheer.achternaam}`,
    doel_client_id: doel.client_id || "",
    doel_pv_naam: doel.pv || "",
    ticketnummer: doel.ticket || "",
    reden: `Opvraag door eigen werkgever ${ctx.org.naam}. ${reden}`.slice(0, 400),
    soort: "WERKGEVER_INZAGE",
    niveau: "HIGH",
    bron: "ambassadeur",
  });
}

async function zoekGebruiker(client, email) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) return null;
    const hit = data.users.find((user) => String(user.email || "").toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function nodigUit(client, ctx, rij) {
  const email = mailOk(rij.email);
  const voornaam = schoon(rij.voornaam, 40);
  const achternaam = schoon(rij.achternaam, 60);
  if (!email || voornaam.length < 2 || achternaam.length < 2) return { fout: "Voornaam, achternaam en een zakelijk mailadres zijn verplicht." };
  const bestaandLid = await client.from("boa_org_lid").select("id, status").eq("organisatie_id", ctx.org.id).eq("email", email).maybeSingle();
  if (bestaandLid.data && bestaandLid.data.status !== "uitgenodigd") return { fout: "Deze persoon staat al bij uw organisatie." };
  const code = token();
  const verloopt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const rol = rij.rol === "beheerder" ? "beheerder" : "gebruiker";
  const velden = { organisatie_id: ctx.org.id, voornaam, achternaam, email, rol, status: "uitgenodigd", token: code, verloopt, user_id: null };
  const schrijf = bestaandLid.data
    ? await client.from("boa_org_lid").update(velden).eq("id", bestaandLid.data.id)
    : await client.from("boa_org_lid").insert(velden);
  if (schrijf.error) return { fout: schrijf.error.message };
  const link = `${SITE}/?uitnodiging=${code}`;
  const brief = briefUitnodiging({ voornaam, org: ctx.org.naam, link, beheerder: rol === "beheerder" });
  const mail = await verstuur({
    van: "uitnodiging@ambassadeur.boaportaal.nl",
    passEnv: "UITNODIGING_PASSWORD",
    naar: email,
    onderwerp: "U bent toegevoegd voor BOA Portaal",
    tekst: brief.tekst,
    html: brief.html,
  });
  await logWerkgever(client, ctx, {}, `Uitnodiging verstuurd. Account wordt pas zichtbaar na bevestiging door de persoon zelf.`);
  return { ok: true, mail: mail.ok, mailFout: mail.fout || "" };
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return antwoord(204, {});
  const client = sb();
  if (!client) return antwoord(503, { fout: "De service-sleutel ontbreekt op de server." });
  const q = event.queryStringParameters || {};
  if (event.httpMethod === "GET" && q.uitnodiging) {
    const { data } = await client.from("boa_org_lid").select("voornaam, status, verloopt, organisatie_id, rol").eq("token", q.uitnodiging).maybeSingle();
    if (!data || data.status !== "uitgenodigd" || new Date(data.verloopt).getTime() < Date.now()) {
      return antwoord(410, { fout: "Deze uitnodiging is verlopen of al gebruikt." });
    }
    const { data: org } = await client.from("boa_organisatie").select("naam").eq("id", data.organisatie_id).maybeSingle();
    const { data: rij } = await client.from("boa_org_lid").select("email").eq("token", q.uitnodiging).maybeSingle();
    const bestaand = rij?.email ? await zoekGebruiker(client, rij.email) : null;
    return antwoord(200, { voornaam: data.voornaam, organisatie: org?.naam || "", modus: bestaand ? "koppel" : "nieuw", rol: data.rol, email: rij?.email || "" });
  }
  if (event.httpMethod !== "POST") return antwoord(405, { fout: "Niet toegestaan." });
  const body = lees(event);
  const actie = String(body.actie || "");

  if (actie === "registreer") {
    const naam = schoon(body.organisatie, 80);
    const email = mailOk(body.email);
    const voornaam = schoon(body.voornaam, 40);
    const achternaam = schoon(body.achternaam, 60);
    const password = String(body.wachtwoord || "");
    const slug = stuk(naam);
    const local = mailLocal(voornaam, achternaam);
    const zwak = wachtwoordFout(password, [voornaam, achternaam, email, naam]);
    if (naam.length < 2 || !email || !local || zwak) {
      return antwoord(400, { fout: zwak || "Vul organisatie, zakelijk mailadres, voornaam, achternaam en een wachtwoord van minstens 12 tekens in." });
    }
    const bezet = await client.from("boa_organisatie").select("id").eq("slug", slug).maybeSingle();
    if (bezet.data) return antwoord(409, { fout: "Deze organisatienaam is al aangemeld." });
    const gemaakt = await client.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { voornaam, achternaam, naam: `${voornaam} ${achternaam}` } });
    if (gemaakt.error || !gemaakt.data.user) return antwoord(400, { fout: gemaakt.error?.message || "Account niet aangemaakt." });
    const mailGeheim = geheim();
    const org = await client.from("boa_organisatie").insert({ naam, slug, domein: email.split("@")[1], mail_geheim: mailGeheim }).select("id").single();
    if (org.error) return antwoord(500, { fout: org.error.message });
    await client.from("boa_ambassadeur").insert({
      organisatie_id: org.data.id,
      user_id: gemaakt.data.user.id,
      voornaam,
      achternaam,
      email,
      mail_local: local,
    });
    const persoon = await postbus({ local, password, domain: "ambassadeur.boaportaal.nl" });
    const bus = await postbus({ local: slug, password: mailGeheim, domain: "ambassadeur.boaportaal.nl" });
    return antwoord(200, {
      ok: true,
      mail: `${local}@ambassadeur.boaportaal.nl`,
      organisatiebus: `${slug}@ambassadeur.boaportaal.nl`,
      postbus: persoon.ok ? "" : persoon.fout,
      orgbus: bus.ok ? "" : bus.fout,
    });
  }

  if (actie === "bevestig") {
    const code = String(body.token || "");
    const { data: lid } = await client.from("boa_org_lid").select("*").eq("token", code).maybeSingle();
    if (!lid || lid.status !== "uitgenodigd" || new Date(lid.verloopt).getTime() < Date.now()) {
      return antwoord(410, { fout: "Deze uitnodiging is verlopen of al gebruikt." });
    }
    const bestaand = await zoekGebruiker(client, lid.email);
    if (bestaand) return antwoord(409, { fout: "Dit adres heeft al een account. Log in en kies zelf toevoegen bij de werkgever." });
    const password = String(body.wachtwoord || "");
    const zwak = wachtwoordFout(password, [lid.voornaam, lid.achternaam, lid.email]);
    if (zwak) return antwoord(400, { fout: zwak });
    const gemaakt = await client.auth.admin.createUser({
      email: lid.email,
      password,
      email_confirm: true,
      user_metadata: { voornaam: lid.voornaam, achternaam: lid.achternaam, naam: `${lid.voornaam} ${lid.achternaam}` },
    });
    if (gemaakt.error || !gemaakt.data.user) return antwoord(400, { fout: gemaakt.error?.message || "Account niet aangemaakt." });
    const { data: org } = await client.from("boa_organisatie").select("naam").eq("id", lid.organisatie_id).maybeSingle();
    await client.from("boa_identiteit").update({ organisatie: org?.naam || "" }).eq("user_id", gemaakt.data.user.id);
    await client.from("boa_org_lid").update({ status: "aangemaakt", user_id: gemaakt.data.user.id, token: token() }).eq("id", lid.id);
    if (lid.rol === "beheerder") {
      const local = mailLocal(lid.voornaam, lid.achternaam);
      await client.from("boa_ambassadeur").insert({
        organisatie_id: lid.organisatie_id,
        user_id: gemaakt.data.user.id,
        voornaam: lid.voornaam,
        achternaam: lid.achternaam,
        email: lid.email,
        mail_local: local,
      });
      await postbus({ local, password, domain: "ambassadeur.boaportaal.nl" });
    }
    return antwoord(200, { ok: true, email: lid.email });
  }

  if (actie === "koppel") {
    const code = String(body.token || "");
    const ctxUser = await client.auth.getUser(String(body.jwt || ""));
    const user = ctxUser.data?.user;
    if (!user?.email) return antwoord(401, { fout: "Log eerst in met het account dat u wilt koppelen." });
    const { data: lid } = await client.from("boa_org_lid").select("*").eq("token", code).maybeSingle();
    if (!lid || lid.status !== "uitgenodigd" || new Date(lid.verloopt).getTime() < Date.now()) {
      return antwoord(410, { fout: "Deze uitnodiging is verlopen of al gebruikt." });
    }
    if (user.email.toLowerCase() !== lid.email) return antwoord(403, { fout: "Dit account hoort niet bij de uitnodiging." });
    const { data: org } = await client.from("boa_organisatie").select("naam").eq("id", lid.organisatie_id).maybeSingle();
    await client.from("boa_identiteit").update({ organisatie: org?.naam || "" }).eq("user_id", user.id);
    await client.from("boa_org_lid").update({ status: "gekoppeld", user_id: user.id, token: token() }).eq("id", lid.id);
    if (lid.rol === "beheerder") {
      await client.from("boa_ambassadeur").upsert({
        organisatie_id: lid.organisatie_id,
        user_id: user.id,
        voornaam: lid.voornaam,
        achternaam: lid.achternaam,
        email: lid.email,
        mail_local: mailLocal(lid.voornaam, lid.achternaam),
        actief: true,
      }, { onConflict: "organisatie_id,email" });
    }
    return antwoord(200, { ok: true });
  }

  const ctx = await wie(event, client);
  if (!ctx) return antwoord(401, { fout: "Log opnieuw in als beheerder van uw organisatie." });

  if (actie === "ik") {
    return antwoord(200, { naam: `${ctx.beheer.voornaam} ${ctx.beheer.achternaam}`, organisatie: ctx.org.naam, mail: `${ctx.beheer.mail_local}@ambassadeur.boaportaal.nl`, bus: `${ctx.org.slug}@ambassadeur.boaportaal.nl` });
  }

  if (actie === "mensen") {
    const { data } = await client.from("boa_org_lid").select("id, voornaam, achternaam, email, rol, status, verloopt, user_id, created_at").eq("organisatie_id", ctx.org.id).order("created_at", { ascending: false });
    await logWerkgever(client, ctx, {}, "Overzicht van het eigen personeel.");
    const rijen = [];
    for (const lid of data || []) {
      let client_id = "";
      let locked = false;
      if (lid.user_id && lid.status !== "uitgenodigd") {
        const ident = await client.from("boa_identiteit").select("client_id, locked").eq("user_id", lid.user_id).maybeSingle();
        client_id = ident.data?.client_id || "";
        locked = Boolean(ident.data?.locked);
      }
      rijen.push({
        id: lid.id,
        voornaam: lid.voornaam,
        achternaam: lid.achternaam,
        email: lid.email,
        rol: lid.rol,
        status: lid.status === "uitgenodigd" ? "Nog niet bevestigd" : "Account staat",
        verloopt: lid.verloopt,
        client_id,
        locked,
        klaar: lid.status !== "uitgenodigd",
      });
    }
    return antwoord(200, { mensen: rijen });
  }

  if (actie === "nodig") {
    const uitslag = await nodigUit(client, ctx, body);
    return antwoord(uitslag.fout ? 400 : 200, uitslag);
  }

  if (actie === "import") {
    const lijst = Array.isArray(body.rijen) ? body.rijen.slice(0, 200) : [];
    let goed = 0;
    const fouten = [];
    for (const rij of lijst) {
      const uitslag = await nodigUit(client, ctx, rij);
      if (uitslag.fout) fouten.push(`${rij.email || "regel"}: ${uitslag.fout}`);
      else goed += 1;
    }
    return antwoord(200, { goed, fouten: fouten.slice(0, 8) });
  }

  if (actie === "tickets") {
    const { data: leden } = await client.from("boa_org_lid").select("user_id").eq("organisatie_id", ctx.org.id).not("user_id", "is", null);
    const ids = (leden || []).map((lid) => lid.user_id);
    const { data: opNaam } = await client.from("boa_ticket").select("id, nummer, pv_naam, client_id, organisatie, categorie, status, onderwerp, lijn, created_at").ilike("organisatie", ctx.org.naam).order("created_at", { ascending: false }).limit(100);
    let opPersoon = [];
    if (ids.length) {
      const tweede = await client.from("boa_ticket").select("id, nummer, pv_naam, client_id, organisatie, categorie, status, onderwerp, lijn, created_at").in("indiener_id", ids).order("created_at", { ascending: false }).limit(100);
      opPersoon = tweede.data || [];
    }
    const gezien = new Set();
    const tickets = [];
    for (const ticket of [...(opNaam || []), ...opPersoon]) {
      if (gezien.has(ticket.id)) continue;
      gezien.add(ticket.id);
      tickets.push(ticket);
    }
    await logWerkgever(client, ctx, {}, "Overzicht van de tickets van de eigen organisatie.");
    return antwoord(200, { tickets });
  }

  if (actie === "ticket") {
    const { data: ticket } = await client.from("boa_ticket").select("*").eq("nummer", String(body.nummer || "")).maybeSingle();
    if (!ticket || String(ticket.organisatie || "").toLowerCase() !== ctx.org.naam.toLowerCase()) {
      const lid = ticket ? await client.from("boa_org_lid").select("id").eq("organisatie_id", ctx.org.id).eq("user_id", ticket.indiener_id).maybeSingle() : { data: null };
      if (!lid.data) return antwoord(404, { fout: "Dit ticket hoort niet bij uw organisatie." });
    }
    const { data: log } = await client.from("boa_ticket_log").select("moment, actor, tekst").eq("ticket_id", ticket.id).order("moment", { ascending: true });
    await logWerkgever(client, ctx, { client_id: ticket.client_id, pv: ticket.pv_naam, ticket: ticket.nummer }, `Ticket ${ticket.nummer} ingezien.`);
    return antwoord(200, { ticket, log: log || [] });
  }

  if (actie === "antwoord" || actie === "doorzetten") {
    const { data: ticket } = await client.from("boa_ticket").select("id, nummer, client_id, pv_naam, indiener_id, organisatie").eq("nummer", String(body.nummer || "")).maybeSingle();
    if (!ticket) return antwoord(404, { fout: "Ticket niet gevonden." });
    const eigen = String(ticket.organisatie || "").toLowerCase() === ctx.org.naam.toLowerCase();
    const lid = await client.from("boa_org_lid").select("id").eq("organisatie_id", ctx.org.id).eq("user_id", ticket.indiener_id).maybeSingle();
    if (!eigen && !lid.data) return antwoord(403, { fout: "Dit ticket hoort niet bij uw organisatie." });
    const tekst = schoon(body.tekst, 2000);
    if (tekst.length < 3) return antwoord(400, { fout: "Schrijf een korte notitie." });
    if (actie === "doorzetten") {
      await client.from("boa_ticket").update({ lijn: "beheer", status: "In Behandeling (2e Lijn)", updated_at: new Date().toISOString() }).eq("id", ticket.id);
    }
    await client.from("boa_ticket_log").insert({
      ticket_id: ticket.id,
      actor: `${ctx.beheer.voornaam} ${ctx.beheer.achternaam}`,
      tekst: actie === "doorzetten" ? `Doorgezet naar de 2e lijn door de werkgever. ${tekst}` : tekst,
    });
    await logWerkgever(client, ctx, { client_id: ticket.client_id, pv: ticket.pv_naam, ticket: ticket.nummer }, actie === "doorzetten" ? "Ticket doorgezet naar de 2e lijn." : "Antwoord op eigen ticket.");
    return antwoord(200, { ok: true });
  }

  if (actie === "opnieuw") {
    const { data: lid } = await client.from("boa_org_lid").select("*").eq("id", body.id).eq("organisatie_id", ctx.org.id).maybeSingle();
    if (!lid) return antwoord(404, { fout: "Deze persoon hoort niet bij uw organisatie." });
    if (lid.status !== "uitgenodigd") return antwoord(400, { fout: "Dit account is al bevestigd. Stuur een wachtwoord-reset." });
    const uit = await nodigUit(client, ctx, lid);
    if (uit.fout) return antwoord(400, { fout: uit.fout });
    return antwoord(uit.mail ? 200 : 502, uit.mail ? { ok: true } : { fout: uit.mailFout || "De uitnodiging is niet verstuurd." });
  }

  if (actie === "reset" || actie === "ontgrendel" || actie === "pauze") {
    const { data: lid } = await client.from("boa_org_lid").select("*").eq("id", body.id).eq("organisatie_id", ctx.org.id).maybeSingle();
    if (!lid || !lid.user_id || lid.status === "uitgenodigd") return antwoord(404, { fout: "Dit account is nog niet bevestigd." });
    const ident = await client.from("boa_identiteit").select("client_id, pv_naam, locked").eq("user_id", lid.user_id).maybeSingle();
    const doel = { client_id: ident.data?.client_id || "", pv: ident.data?.pv_naam || `${lid.voornaam} ${lid.achternaam}` };
    if (actie === "ontgrendel") {
      await client.from("boa_identiteit").update({ locked: false, slot_tot: null, slot_straf: false }).eq("user_id", lid.user_id);
      await logWerkgever(client, ctx, doel, "Account ontgrendeld door de eigen werkgever.");
      return antwoord(200, { ok: true });
    }
    if (actie === "pauze") {
      await client.from("boa_identiteit").update({ mfa_ok_tot: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString() }).eq("user_id", lid.user_id);
      await logWerkgever(client, ctx, doel, "Tweestapsverificatie 8 uur uitgezet door de eigen werkgever.");
      return antwoord(200, { ok: true });
    }
    const link = await client.auth.admin.generateLink({ type: "recovery", email: lid.email, options: { redirectTo: "https://boaportaal.nl/account" } });
    const url = link.data?.properties?.action_link || "";
    if (!url) return antwoord(500, { fout: "De herstelmail kon niet worden gemaakt." });
    const mail = await verstuur({
      van: "noreply@boaportaal.nl",
      passEnv: "NOREPLY_PASSWORD",
      naar: lid.email,
      onderwerp: "Kies een nieuw wachtwoord voor BOA Portaal",
      tekst: `Beste ${lid.voornaam},\n\nUw werkgever heeft een wachtwoordherstel aangevraagd.\n\nKies zelf een nieuw wachtwoord via deze knop. Open de link niet vanuit een automatische scanner.\n${url}\n\nGroet,\nBOA Portaal`,
      html: `<div style="font-family:Segoe UI,sans-serif;font-size:16px;line-height:1.5;color:#0f172a"><p>Beste ${lid.voornaam},</p><p>Uw werkgever heeft een wachtwoordherstel aangevraagd.</p><p><a href="${url}" style="display:inline-block;background:#0F2537;color:#fff;text-decoration:none;padding:10px 16px">Nieuw wachtwoord kiezen</a></p><p>Open deze knop zelf. Een mailscanner mag hem niet alvast openen.</p><p>Groet,<br>BOA Portaal</p></div>`,
    });
    await logWerkgever(client, ctx, doel, "Wachtwoordherstel verstuurd door de eigen werkgever. Het adres staat niet in dit log.");
    return antwoord(mail.ok ? 200 : 502, mail.ok ? { ok: true } : { fout: mail.fout });
  }

  return antwoord(400, { fout: "Onbekende actie." });
}
