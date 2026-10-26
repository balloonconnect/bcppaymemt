// Site settings. Edit these four values after setting up the backend (see README.md).
// None of these are secrets — they are visible to anyone who opens the site.
window.BCP_CONFIG = {
  // Apps Script Web app URL (Deploy → Manage deployments → Web app → URL ending in /exec)
  API_URL: 'https://script.google.com/macros/s/AKfycbw96gnjtZ7bphLvChEj7E-C-pVU1LW1hgq2n60yC_2ttbHBJ9zmJTSDa_UNjbsyVkESzg/exec',

  // Google Cloud OAuth "Web application" client ID, used only for the admin sign-in
  GOOGLE_CLIENT_ID: '709434409817-6hq6c3f1q9g1bcj0on3dcnuos9n7tjlp.apps.googleusercontent.com',

  // The UPI ID customers pay to (also used for the "Open UPI app" button, with the balance filled in).
  UPI_ID: '7094295334@okbizaxis',
  PAYEE_NAME: 'Balloon Connect Photography',

  // Your own UPI QR image shown on the payment card (assets/upi-qr.png). Static QR codes don't carry the amount,
  // so the page tells customers exactly what to enter. Clear this to show a QR generated from UPI_ID with the amount filled in.
  QR_IMAGE: 'assets/upi-qr.png',

  // Optional: WhatsApp number (country code + number, digits only) for the "Need help?" link.
  // Leave empty to hide the link. Example: '919876543210'
  WHATSAPP_NUMBER: '917094295334'
};
