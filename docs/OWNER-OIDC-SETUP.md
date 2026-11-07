# Owner setup: Google and Microsoft sign-in for Nexus (ADR-0010)

> **Status 2026-11-07: not in use.** The owner tried this setup, and it failed because of Google's and Microsoft's own policies. Nexus signs in with the Cloudflare Access **one-time PIN** by email (ADR-0010). This guide is kept in case OIDC is added later. Provisioning picks the providers up without a code change.

Nexus (`https://nexus.cryptophys.work`, with the Console at `/console/`) is protected by the Cloudflare Access application `cryptophys-cloud-platform`. Access is the only login. The platform stores no password, session or OAuth secret.

The two owners sign in with their own providers:

| Owner | Provider |
|---|---|
| `cryptophys.adm@gmail.com` | Google |
| `afif.kw@outlook.com` | Microsoft (personal account) |

The one-time PIN by email stays available as a fallback.

**Only the owner can do these steps.** Each provider issues a client secret, and it goes straight into the Cloudflare dashboard; it never passes through chat, GitHub or this repository. After both providers are added, ask the orchestrator to run **Provision Access**. Provisioning selects every Google, Microsoft and one-time-PIN provider it finds, and puts `nexus.cryptophys.work` in the same application as the Console.

Team domain: `cryptophys.cloudflareaccess.com`. The callback URL used below is:

```
https://cryptophys.cloudflareaccess.com/cdn-cgi/access/callback
```

## 1. Google (for cryptophys.adm@gmail.com)

1. In the Google Cloud console, choose or create a project.
2. Go to **APIs & Services → OAuth consent screen** and configure it:
   - **User type:** External. Fill in the app name and support email.
   - **Scopes:** `openid`, `email` and `profile`.
   - **Test users:** add `cryptophys.adm@gmail.com`, or publish the app.
3. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - **Application type:** Web application.
   - **Authorized JavaScript origins:** `https://cryptophys.cloudflareaccess.com`.
   - **Authorized redirect URIs:** the callback URL above.
4. Copy the **Client ID** and the **Client secret**.
5. In Cloudflare, go to **Zero Trust → Integrations → Identity providers → Add new → Google**. Paste the two values, select **Save**, then **Test**.

## 2. Microsoft (for afif.kw@outlook.com, a personal account)

Personal Microsoft accounts are not inside an organization's Entra tenant. Use Cloudflare's **Generic OIDC** connector with Microsoft's `consumers` endpoint:

1. Open the Microsoft Entra admin center, or the Azure portal with the same Microsoft account. Go to **App registrations → New registration**:
   - **Supported account types:** *Personal Microsoft accounts only*.
   - **Redirect URI (Web):** the callback URL above.
2. Under **Certificates & secrets**, select **New client secret** and copy its **Value**. Note the expiry date: renew the secret before it expires, or sign-in with this provider stops.
3. Under **API permissions**, keep Microsoft Graph delegated `openid`, `email`, `profile` and `User.Read`.
4. In Cloudflare, go to **Zero Trust → Integrations → Identity providers → Add new → OpenID Connect**:
   - **Name:** `Microsoft`.
   - **App ID:** the Application (client) ID. **Client secret:** the secret from step 2.
   - **Auth URL:** `https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize`.
   - **Token URL:** `https://login.microsoftonline.com/consumers/oauth2/v2.0/token`.
   - **Certificate URL:** `https://login.microsoftonline.com/consumers/discovery/v2.0/keys`.
   - **OIDC claims:** `email`. Enable **PKCE**.
   - Select **Save**, then **Test**.

If the outlook.com account belongs to an Entra tenant, the **Azure AD** connector also works. In that case, use the tenant's Directory ID and follow Cloudflare's Entra ID guide.

## 3. After the providers are added

- Tell the orchestrator. It runs **Provision Access**, which binds the providers to the application and verifies at the edge that Nexus requires sign-in.
- Sign in at `https://nexus.cryptophys.work`. On the Access login page, choose Google or Microsoft. The Console is under **Cerebrum Console** in the Nexus menu, or directly at `https://nexus.cryptophys.work/console/`.
- Who may enter is unchanged: the `ACCESS_ALLOWED_EMAILS` list. A provider that returns a different email is refused.
