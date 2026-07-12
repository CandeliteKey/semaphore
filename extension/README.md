# Cookie Clip

Cookie Clip is a Manifest V3 extension for Zen/Firefox. It reads cookies for a
confirmed domain (including HttpOnly cookies) and sends them to the local
Semaphore ingestion endpoint.

## Load temporarily in Zen

1. Open `about:debugging` in Zen.
2. Select **This Firefox**.
3. Select **Load Temporary Add-on**.
4. Choose `manifest.json` from this directory.

Temporary extensions are removed when Zen exits and must be loaded again.

## Install as an unsigned package

From inside this directory, package the files at the root of the archive:

```sh
zip -r cookie-clip.xpi manifest.json popup.html popup.css popup.js README.md
```

With signature enforcement disabled in Zen, open `about:addons`, choose
**Install Add-on From File…** from the gear menu, and select `cookie-clip.xpi`.

## Configure and use

Get the generated shared secret from the container logs:

```sh
docker logs semaphore
```

Open a site whose cookies you want to share, select Cookie Clip in the toolbar,
paste the secret, confirm the detected domain, and select **Clip cookies**. The
secret is saved in `browser.storage.local` in the current browser profile and is
never included in this extension's source.

The extension requests `<all_urls>` as a required host permission. This is the
simplest Firefox setup that permits `browser.cookies.getAll` to read cookies for
the active site without a separate permission prompt. Cookie Clip only reads the
domain explicitly shown and confirmed in its popup.

Domain detection uses the last two hostname labels. It does not use the Public
Suffix List, so domains such as `service.example.co.uk` are initially detected as
`co.uk`; edit the field to `example.co.uk` before clipping.
