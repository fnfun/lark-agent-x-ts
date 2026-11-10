/**
 * Web APIs of the Lark / Feishu web apps (Docs, Drive, Wiki, Base, Calendar, Mail, Minutes, OKR):
 * HTTP + JSON on the tenant domain (https://<tenant>.<region domain>), authenticated by the same
 * login cookies as the messaging gateway. Opening an app's entry page once sets that app's cookies
 * (Docs sets sl_session and passport_app_access_token, for example); requests are sent with them.
 *
 * Availability with QR-login cookies, tested on a Lark (international) account on 2026-11-10 with
 * read-only requests:
 *
 * | App | Entry page | Result |
 * |---|---|---|
 * | Docs / Drive / Wiki / Base | /drive/home/, /wiki/, /base/ | pages open; /space/api/user/, my space and search return code 0 |
 * | Calendar | /calendar/ | page opens |
 * | Mail | /mail | page opens |
 * | Minutes | /minutes/home | page opens |
 * | OKR | /okr/ | page opens |
 * | Approval, Attendance | /approval/, /attendance/ | 404 on that tenant |
 * | Miaoda | — | no entry on Lark (international); it is a Feishu product |
 *
 * Tasks need no web app: the web client's tasks go through the gateway (`todo.*`).
 */
import type { LarkAuth } from './auth.js';
import { AuthExpired } from './auth.js';
import { CookieJar, HttpError, USER_AGENT } from './http.js';

/** Entry page whose visit sets the cookies an API path needs, by path prefix. */
const ENTRY_PAGES: [string, string][] = [
  ['/space/', '/drive/home/'],
  ['/minutes/', '/minutes/home'],
  ['/okr/', '/okr/'],
  ['/calendar/', '/calendar/'],
  ['/mail', '/mail'],
];
const DEFAULT_ENTRY = '/next/messenger/';
/**
 * Writes to Docs need the X-CSRFToken header, taken from the _csrf_token cookie that
 * /space/api/user/ sets.
 */
const CSRF = { prefix: '/space/', cookie: '_csrf_token', bootstrap: '/space/api/user/' };
const LOGIN_PATH = '/accounts/page/login';

export interface WebRequest {
  /** Query parameters, appended to the path. */
  query?: Record<string, string | number | boolean> | undefined;
  /** A JSON body (sent as application/json). */
  json?: unknown;
  /** A form body (sent as application/x-www-form-urlencoded); an array repeats its key. */
  form?: Record<string, string | number | boolean | readonly string[]> | undefined;
  /** A multipart body (file uploads). */
  multipart?: FormData | undefined;
  /** Send to this origin instead of the tenant's (e.g. Drive's upload host). */
  origin?: string | undefined;
  headers?: Record<string, string> | undefined;
}

export class WebSession {
  private readonly jar: CookieJar;
  private tenant: string | null = null;
  private readonly warmed = new Set<string>();

  /**
   * entry is where tenant discovery starts (the region's www host by default; tests point it at a
   * fake server).
   */
  constructor(
    readonly auth: LarkAuth,
    private readonly entry = `https://www.${auth.region.domain}`,
  ) {
    this.jar = new CookieJar(auth.cookies);
  }

  /**
   * The tenant origin, found by following the messenger page's redirect once; throws AuthExpired
   * when the redirect ends on the login page.
   */
  async origin(): Promise<string> {
    if (this.tenant) return this.tenant;
    const res = await this.page(`${this.entry}${DEFAULT_ENTRY}`);
    this.tenant = new URL(res.url).origin;
    this.warmed.add(DEFAULT_ENTRY);
    return this.tenant;
  }

  /** Opens an app's entry page once, so the app's cookies are set for later requests. */
  async warm(entryPage: string): Promise<void> {
    if (this.warmed.has(entryPage)) return;
    await this.page(`${await this.origin()}${entryPage}`);
    this.warmed.add(entryPage);
  }

  /**
   * Calls a web API; path is relative to the tenant origin (e.g. /space/api/user/). The app's entry
   * page is opened first when needed. Throws AuthExpired when bounced to the login page, HttpError
   * on a non-2xx status, NetworkError when the connection fails.
   */
  async request(method: string, path: string, o: WebRequest = {}): Promise<Response> {
    await this.warm(ENTRY_PAGES.find(([prefix]) => path.startsWith(prefix))?.[1] ?? DEFAULT_ENTRY);
    const tenant = await this.origin();
    const url = new URL(path, o.origin ?? tenant);
    for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      accept: 'application/json, text/plain, */*',
      origin: tenant,
      referer: `${tenant}/`,
    };
    if (method !== 'GET' && path.startsWith(CSRF.prefix))
      headers['x-csrftoken'] = await this.csrfToken();
    let body: RequestInit['body'];
    if (o.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(o.json);
    } else if (o.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(
        Object.entries(o.form).flatMap(([k, v]) =>
          (Array.isArray(v) ? v : [v]).map((x) => [k, String(x)] as [string, string]),
        ),
      ).toString();
    } else if (o.multipart) body = o.multipart;
    const res = await this.jar.fetch(url.toString(), {
      method,
      headers: { ...headers, ...(o.headers ?? {}) },
      ...(body === undefined ? {} : { body }),
    });
    if (new URL(res.url).pathname.startsWith(LOGIN_PATH))
      throw new AuthExpired('网页登录态已失效,请重新登录(lark auth qr)');
    if (!res.ok) throw new HttpError(res.status, res.statusText, res.url, await reason(res));
    return res;
  }

  /**
   * Like request, but parses the JSON body; a `{code: 5, msg: "Login Required"}` reply (how the
   * web APIs answer a missing login) throws AuthExpired. Other non-zero codes are returned as is,
   * since each app gives them its own meaning.
   */
  async json(method: string, path: string, o: WebRequest = {}): Promise<unknown> {
    const res = await this.request(method, path, o);
    const body = (await res.json()) as unknown;
    const b = body as { code?: unknown; msg?: unknown } | null;
    if (b && b.code === 5 && /login/i.test(String(b.msg ?? '')))
      throw new AuthExpired('网页登录态已失效,请重新登录(lark auth qr)');
    return body;
  }

  /** Docs' CSRF token: the _csrf_token cookie, fetched once when missing. */
  private async csrfToken(): Promise<string> {
    if (!this.jar.cookies[CSRF.cookie]) await this.request('GET', CSRF.bootstrap);
    return this.jar.cookies[CSRF.cookie] ?? '';
  }

  private async page(url: string): Promise<Response> {
    const res = await this.jar.fetch(url, { headers: { 'user-agent': USER_AGENT } });
    await res.arrayBuffer();
    if (new URL(res.url).pathname.startsWith(LOGIN_PATH))
      throw new AuthExpired('网页登录态已失效,请重新登录(lark auth qr)');
    if (!res.ok) throw new HttpError(res.status, res.statusText, res.url, '');
    return res;
  }
}

async function reason(res: Response): Promise<string> {
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t) as { msg?: string; message?: string };
      return String(j.msg ?? j.message ?? t).slice(0, 300);
    } catch {
      return t.slice(0, 300);
    }
  } catch {
    return '';
  }
}
