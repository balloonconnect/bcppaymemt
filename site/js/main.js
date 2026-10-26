/* Tiny hash router: "#/admin" opens the admin screen, everything else is the customer screen. */
(function () {
  'use strict';
  const BCP = window.BCP;
  const customer = document.getElementById('screen-customer');
  const admin = document.getElementById('screen-admin');

  function route() {
    const isAdmin = /^#\/admin\b/.test(location.hash);
    customer.hidden = isAdmin;
    admin.hidden = !isAdmin;
    if (isAdmin) {
      document.title = 'Payment Review · Balloon Connect Photography';
      BCP.customer.stop();
      BCP.admin.start();
    } else {
      document.title = 'Photo Delivery · Balloon Connect Photography';
      BCP.admin.stop();
      BCP.customer.start();
    }
  }

  window.addEventListener('hashchange', route);
  route();
})();
