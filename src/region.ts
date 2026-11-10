/**
 * Site differences between Feishu (China) and Lark (international).
 *
 * Both share the same web client code and protocol: API paths, proto and the access_key algorithm
 * are identical; they differ only in domain, web appId (gateway request header x-appid) and default
 * locale. The region is chosen at login and written into the credentials; every later request takes
 * its addresses from the region in the credentials (cookies are only valid for their own domain and
 * cannot be mixed).
 */
export interface Region {
  name: 'feishu' | 'lark';
  label: string;
  domain: string;
  /**
   * Fallback for the page's `__feishuMeta.teaAppId`; after login the actual value is scraped from
   * the messenger page and stored in the credentials.
   */
  webAppId: string;
  locale: string;
}

export const REGIONS: Record<Region['name'], Region> = {
  feishu: {
    name: 'feishu',
    label: '飞书',
    domain: 'feishu.cn',
    webAppId: '161471',
    locale: 'zh_CN',
  },
  lark: {
    name: 'lark',
    label: 'Lark',
    domain: 'larksuite.com',
    webAppId: '161471',
    locale: 'en_US',
  },
};

export function getRegion(name: string): Region {
  const region = REGIONS[(name || '').trim().toLowerCase() as Region['name']];
  if (!region) throw new Error(`未知区域: '${name}',可选: ${Object.keys(REGIONS).join(', ')}`);
  return region;
}

const apiHost = (r: Region) => `https://internal-api-lark-api.${r.domain}`;
export const webOrigin = (r: Region) => `https://open-dev.${r.domain}`;

export const urls = {
  ticket: (r: Region) => `https://login.${r.domain}/suite/passport/frontier_ticket/`,
  userInfo: (r: Region) => `${apiHost(r)}/accounts/web/user`,
  csrf: (r: Region) => `${apiHost(r)}/accounts/csrf`,
  gateway: (r: Region) => `${apiHost(r)}/im/gateway/`,
  messengerPage: (r: Region) => `${webOrigin(r)}/messenger/`,
  qrRedirect: (r: Region) => `${webOrigin(r)}/next/messenger`,
  accountsOrigin: (r: Region) => `https://accounts.${r.domain}`,
  ws: (r: Region) => `wss://msg-frontier.${r.domain}/ws/v2`,
  fileHost: (r: Region) => `https://internal-api-lark-file.${r.domain}`,
};
