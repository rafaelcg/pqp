/** Leave the site for an address (the app). One function so a test can watch where it goes. */
export function go(href: string): void {
  window.location.assign(href);
}
