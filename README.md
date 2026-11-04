# WFC Claim Builder

Staff attach their Touch 'n Go statement, fuel receipts and other receipts. The page fills the WFC monthly claim form, makes the PDF, zips everything into one folder and prepares the email to the accountant.

Everything runs in the browser. Files are never uploaded anywhere, except the optional **Claude backup** (a photo only goes to Claude when a key is saved in Settings and this PC could not read it) and that the optional **Create Gmail draft** button (see below) puts the zip into the user's own Gmail when they press it.

## First use

In the **Save and email** step each person picks their own email from the **From** list (it starts blank every time) and **To** starts as the accountant, agnes@yutech.com.my, and can be typed over. The browser remembers the claimant name on that PC, not the two emails. Settings also holds the accountant's first name and the public-holiday list.

## Run it

- **Windows, quickest:** double-click `Start.bat` (needs Python) and the page opens at http://localhost:8080/.
- **For all staff:** put this whole folder on any static host (Netlify Drop, GitHub Pages, a company web server, SharePoint site). No server code, no build step.

## What it does

The expense claim is four steps, one form on screen at a time. The circles at the top (1 Details, 2 Files, 3 Check, 4 Save and email) turn green as each step is filled in completely, and the line between them turns green too. Click any circle to jump to that step, or use the Back / Next buttons. **Save my claim stays locked until all four are green**; the note under it lists what is still missing, with a link to that step.

1. **Details:** claimant, month (it opens on **last month**, because October is claimed by 15 Nov and November by 15 Dec), optional days off (leave).
2. **Files:** one box. Drag everything in at once, paste with Ctrl+V (files copied in Explorer, or a copied image), or click to browse. The app looks inside each file and sorts it:
   - TNG statement PDF: toll rows are read and checked against the rules below.
   - Eleven Labs / Runway style invoice + receipt PDFs: filled in automatically (merchant, date, amount in MYR, invoice number). The invoice and its receipt share one line.
   - Agoda hotel receipt PDF: hotel, check-in date and MYR total are filled in (category Accommodation).
   - Photos: added as a Petrol line, because they are usually petrol receipts. Staff type the date, station, receipt no. and amount beside the photo (the date is pre-filled from the photo and shown in amber to check). Change the category if it is something else.
   - The amount is always the **final amount paid**. On a Petronas Budi95 receipt that is the TOTAL after the subsidy (RM60.00), never the pre-subsidy item line (RM116.68). If the TOTAL cannot be read, it is the item line less the subsidy; if that cannot be worked out either, the box is left blank (amber hint) rather than guessed.
   - **Claims are always in ringgit.** An invoice or receipt in USD (or SGD, EUR, GBP ...) uses the RM amount printed on it ("Charged RM46.70 using 1 USD = 4.2452 MYR"). If only the foreign amount is shown (an invoice before its receipt), it is converted at that day's European Central Bank rate, shown in amber with a note saying so; add the receipt, or type the figure from the card statement, to replace it. The rate lookup sends only the currency code and the date, never a file. If it cannot be reached the box stays blank with a hint.
   - **MBSJ Flexi Parking monthly receipt** (the email, saved as PDF with Print > Save as PDF, or pasted as a screenshot): category Parking, name MBSJ Flexi Parking, amount = the **Payment** line (RM84.80), never the table Total underneath, which also adds the next period.
   - **How photos are read:** on this PC, no AI service. The reader (Tesseract, high-accuracy model, about 17 MB the first time) finds the paper in the picture, erases everything round it (keys, desk, stickers), straightens a tilted strip, tries the picture turned 90 / 180 / 270 degrees if the first look is poor, reads it in several page layouts, and **votes** across the readings so one misread digit is outvoted. Digits the print loses are repaired (S for 5, G for 6, a missing decimal point after RM). Dot-matrix thermal print (petrol slips) is the hard case: amounts are usually right, dates, receipt numbers and names often are not, so every guessed box is amber and the photo is one click away to check.
   - **Claude backup (optional, plan B):** Settings has a box for an Anthropic API key. With no key, nothing changes and nothing is ever sent. With a key, Claude is asked about a photo (one call, about RM 0.03) only when the normal reader cannot read it, it fails, or its answer looks wrong: no amount, no date, an amount that does not add up, a date in the future or over four months old, or an amount that is too small or too big for the type (petrol under RM10 or over RM400, for example). A normal receipt never goes to Claude. The line then says "Checked again with Claude" and what changed. Without a key the odd result still gets a "Please check" note. At most 30 Claude calls per page visit. Code: `js/planb.js`, test: `node tests/planb.test.js`.
   - Photos are read after the **paper is cut out** of the picture (a receipt lying on a keyboard or desk no longer picks up the keys as text), and a receipt held **sideways** in the frame is turned until it reads. A clinic (**Klinik**, Clinic) receipt is always category **Medical**, with the clinic's full name.
   - Clinic receipts: the amount is read even when it is only written in words ("RM SEVENTY FIVE ONLY"); category Medical.
   - Anything else is checked first and **refused with a reason** (shown under the box): a WFC claim or leave form, a medical certificate (use the Leave tab), a PDF with no receipt wording, a file with no amount, or a photo too blurry to read ("re-attach a clearer photo"). A blurry photo whose numbers can still be read is accepted. For files that could not be read, "Add anyway" lets you type the details by hand (for example a handwritten hotel bill).
   - Use "Attach to" to put several files (hotel receipt + bill + payment proof) on one claim line.
3. **Check:** nothing is locked. Every field on every line can be typed over, including the amounts. **+ Add a line manually** adds a line with no file (a cash expense, say). The toll and parking lines are calculated from the ticked trips, but you can type a different amount, date, name or receipt no. over them; the line then says "Changed by you · calculated RM x" with a **Use calculated** link to go back, and the toll check list PDF records the difference. "See which trips" shows each toll row and why it was counted or not; tick or untick to override.
4. **Save:** the claim form (.xlsx and .pdf) lists fuel first, then toll, parking, medical, AI tools, accommodation and any other claims (by date within each group). It downloads `Claim - <Month Year> - <Name>.zip` containing the claim form (.xlsx and .pdf), the original TNG statement, a **TNG toll check list PDF** (every trip with a ticked or unticked box and the reason, so the accountant can see exactly which trips count), and each receipt renamed `Receipt 01 - Petrol - 06-09-2026.jpg` (the number matches the line on the form).
5. **Email:** subject `Claim - <Month Year>`, to the accountant, from the work email.
   - *Create Gmail draft* (after the one-time setup below) signs in to Google once and puts the To, Subject, message **and the zip** into a draft in the user's own Gmail Drafts. Nothing is sent.
   - *Open Gmail draft* / *Open Gmail without the file* fills To / Subject / message in the work account. Gmail links cannot carry attachments, so drag the zip in.
   - *Download .eml draft* opens in Outlook / Apple Mail with the zip already attached.
   - *Share...* (phones) hands the zip to the Gmail app.

## Gmail draft with the zip attached

A web page cannot attach a file to Gmail through a link, so this button uses the Gmail API with the person's own Google sign-in. The permission asked for is "Manage drafts and send emails" (`gmail.compose`); it cannot read the mailbox. It needs a Google **client ID** (a public value, not a secret). Set it up once for the whole team:

1. Open https://console.cloud.google.com and create a project (for example *WFC Claim Builder*).
2. **APIs & Services > Library:** search for *Gmail API* and **Enable** it.
3. **OAuth consent screen** (shown as *Google Auth platform* in newer consoles): choose **External** (choose **Internal** if everyone is on one Google Workspace domain, which skips the warning in step 6), give it a name and your email, and add the scope `https://www.googleapis.com/auth/gmail.compose`. Leave publishing status on **Testing** and add every colleague's Gmail address under **Test users** (up to 100).
4. **Credentials > Create credentials > OAuth client ID:** application type **Web application**. Under **Authorized JavaScript origins** add `https://zzllchen.github.io` (and `http://localhost:8080` if people also use `Start.bat`). No redirect URI is needed.
5. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`). The team's ID is already built in (`DEFAULTS.gmailClientId` in `js/app.js`, project *WFC Claim Builder* under marketing.wfcsystems@gmail.com), so colleagues need nothing. Someone using their own project can paste theirs in **Settings > Google client ID**.
   - **Test users must be real Google accounts.** Google silently refuses to add an address that is not a Google account (for example a work address on another mail provider), so the Gmail draft button works only for people who sign in with a Google account. Add each such person under **Audience > Test users**, one at a time.
6. On first use Google shows "Google hasn't verified this app": choose **Advanced > Go to WFC Claim Builder**, then allow. In Testing mode Google asks again about once a week.

The draft appears in the Gmail account that was signed in, with the zip attached; open it from the link under the button and press Send.

## Leave application

The **Leave application** tab fills the WFC leave form: employee name, type (annual / sick / unpaid / personal / other, ticked on the form), reason, from / to dates, signature and date signed. The balance boxes stay blank for the office. It makes `WFC - OCT Leave form (6Nov).xlsx` and `.pdf` (month = month signed, date = first day of leave) and prepares an email subject `Leave application - 6 Nov 2026`. For sick leave, drop or paste the **medical certificate (MC)** photo or PDF: the dates, "Sick" and the diagnosis are filled in from it (amber, check them), and the MC is saved and emailed with the leave form. Tick "Also skip toll on these days" to add the leave dates to the expense claim's days off.

## Where files are saved

The first time you press Save my claim, the browser asks you to pick a folder on this PC (Chrome or Edge). That choice is remembered **on this PC only**, so each colleague picks their own.

```
<chosen folder>/
  September 2026/                       claim form (.xlsx + .pdf), TNG statement, toll check list, receipts
  Claim - September 2026 - <Name>.zip   the zip to email
  Leave form/                           leave forms (.xlsx + .pdf)
```

- Change it any time: **Change folder** next to the Save my claim button, or **Settings > Save location** (also has **Forget**).
- Saving the same month again updates that folder. Only files this app wrote earlier are replaced or removed; other files you put there are never touched.
- Browsers without folder access (Safari, Firefox, phones) download the zip instead. After a browser restart, Chrome may ask to allow access to the folder again.

## Toll rules

Counted: every toll on a **work day** (Mon-Fri) **anywhere in Malaysia**, including trips outside KL / Selangor, that is not a public holiday and not a day off.
Not counted: Saturday, Sunday, public holidays, days off (leave days, entered above or added from the Leave tab; these are holidays or trips home), **all parking** (personal by default: the Parking card under the claim lines lists every charge with a tick box, tick the ones to claim), reloads.

- The public-holiday list is a best-effort 2026 list. Check the Islamic holiday dates against the official gazette, add Selangor / one-off holidays, and add the next year's dates in Settings.
- Settings (names, email, lists) are remembered in the browser it is used in.

## Files

```
index.html          page
css/style.css
js/app.js           screen logic
js/tng.js           TNG statement reader + toll rules (also runs in Node for tests)
js/xlsx.js          fills the claim form by patching the base workbook (layout, logo and fonts unchanged)
js/pdf.js           claim form PDF + toll check list PDF
js/ocr.js           reads receipt photos on-device (Tesseract.js)
js/petrol.js        turns the OCR text into date / amount / station / receipt no.
js/receipts.js      reads invoice / receipt PDFs
js/mail.js          Gmail link and .eml draft
js/gmail.js         one-click Gmail draft with the zip attached (Google sign-in + Gmail API)
js/folder.js        remembered save folder (File System Access API)
assets/             base claim form (from the October form) and logo, embedded as data
vendor/             pdf.js, JSZip, jsPDF (bundled, no internet needed)
```
