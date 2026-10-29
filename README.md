# WFC Claim Builder

Staff attach their Touch 'n Go statement, fuel receipts and other receipts. The page fills the WFC monthly claim form, makes the PDF, zips everything into one folder and prepares the email to the accountant.

Everything runs in the browser. Files are never uploaded anywhere.

## First use

Each person types their own work email and the accountant's email in the **Build and email** step once; the browser remembers them on that PC. Settings also holds the accountant's first name and the public-holiday list.

## Run it

- **Windows, quickest:** double-click `Start.bat` (needs Python) and the page opens at http://localhost:8080/.
- **For all staff:** put this whole folder on any static host (Netlify Drop, GitHub Pages, a company web server, SharePoint site). No server code, no build step.

## What it does

1. **Details:** claimant, month, optional days off (leave).
2. **Files:** one box. Drag everything in at once, paste with Ctrl+V (files copied in Explorer, or a copied image), or click to browse. The app looks inside each file and sorts it:
   - TNG statement PDF: toll rows are read and checked against the rules below.
   - Eleven Labs / Runway style invoice + receipt PDFs: filled in automatically (merchant, date, amount in MYR, invoice number). The invoice and its receipt share one line.
   - Agoda hotel receipt PDF: hotel, check-in date and MYR total are filled in (category Accommodation).
   - Photos: added as a Petrol line, because they are usually petrol receipts. Staff type the date, station, receipt no. and amount beside the photo (the date is pre-filled from the photo and shown in amber to check). Change the category if it is something else.
   - Clinic receipts: the amount is read even when it is only written in words ("RM SEVENTY FIVE ONLY"); category Medical.
   - Anything else is checked first and **refused with a reason** (shown under the box): a WFC claim or leave form, a medical certificate (use the Leave tab), a PDF with no receipt wording, a file with no amount, or a photo too blurry to read ("re-attach a clearer photo"). A blurry photo whose numbers can still be read is accepted. For files that could not be read, "Add anyway" lets you type the details by hand (for example a handwritten hotel bill).
   - Use "Attach to" to put several files (hotel receipt + bill + payment proof) on one claim line.
3. **Check:** every line is editable. "Review trips" shows each toll row and why it was counted or not; tick or untick to override.
4. **Build:** downloads `Claim - <Month Year> - <Name>.zip` containing the claim form (.xlsx and .pdf), the original TNG statement, a **TNG toll check list PDF** (every trip with a ticked or unticked box and the reason, so the accountant can see exactly which trips count), and each receipt renamed `Receipt 01 - Petrol - 06-09-2026.jpg` (the number matches the line on the form).
5. **Email:** subject `Claim - <Month Year>`, to the accountant, from the work email.
   - *Open Gmail draft* fills To / Subject / message in the work account. Gmail links cannot carry attachments, so drag the zip in.
   - *Download .eml draft* opens in Outlook / Apple Mail with the zip already attached.
   - *Share...* (phones) hands the zip to the Gmail app.

## Leave application

The **Leave application** tab fills the WFC leave form: employee name, type (annual / sick / unpaid / personal / other, ticked on the form), reason, from / to dates, signature and date signed. The balance boxes stay blank for the office. It makes `WFC - OCT Leave form (6Nov).xlsx` and `.pdf` (month = month signed, date = first day of leave) and prepares an email subject `Leave application - 6 Nov 2026`. For sick leave, drop or paste the **medical certificate (MC)** photo or PDF: the dates, "Sick" and the diagnosis are filled in from it (amber, check them), and the MC is saved and emailed with the leave form. Tick "Also skip toll on these days" to add the leave dates to the expense claim's days off.

## Where files are saved

The first time you build, the browser asks you to pick a folder on this PC (Chrome or Edge). That choice is remembered **on this PC only**, so each colleague picks their own.

```
<chosen folder>/
  September 2026/                       claim form (.xlsx + .pdf), TNG statement, toll check list, receipts
  Claim - September 2026 - <Name>.zip   the zip to email
  Leave form/                           leave forms (.xlsx + .pdf)
```

- Change it any time: **Change folder** next to the Build button, or **Settings > Save location** (also has **Forget**).
- Building the same month again updates that folder. Only files this app wrote earlier are replaced or removed; other files you put there are never touched.
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
js/folder.js        remembered save folder (File System Access API)
assets/             base claim form (from the October form) and logo, embedded as data
vendor/             pdf.js, JSZip, jsPDF (bundled, no internet needed)
```
