import "./LandingPage.css";
import "./LegalPage.css";
import logoThumb from "../assets/brand/wickops-logo-thumb.svg";

export function CookiePage() {
  return (
    <div className="legal-page">
      <header className="lp-nav">
        <a className="lp-brand" href="/">
          <img className="lp-brand-mark-image" src={logoThumb} alt="WickOps mark" />
          <span className="lp-brand-word">WickOps</span>
        </a>
        <nav className="lp-nav-actions">
          <a className="lp-link" href="/app">Log In</a>
          <a className="lp-button lp-button-primary" href="/signup">Sign Up</a>
        </nav>
      </header>

      <div className="legal-content">
        <h1>COOKIE POLICY</h1>
        <p className="legal-subtitle"><strong>Last updated</strong> April 02, 2026</p>

        <p>
          This Cookie Policy explains how Wired Wick Consulting LLC (&quot;Company,&quot;
          &quot;we,&quot; &quot;us,&quot; and &quot;our&quot;) uses cookies and similar technologies
          to recognize you when you visit our website at{" "}
          <a href="https://systems.wickops.com" target="_blank" rel="noopener noreferrer">
            https://systems.wickops.com
          </a>{" "}
          (&quot;Website&quot;). It explains what these technologies are and why we use them, as
          well as your rights to control our use of them.
        </p>
        <p>
          In some cases we may use cookies to collect personal information, or that becomes personal
          information if we combine it with other information.
        </p>

        {/* ── TABLE OF CONTENTS ──────────────────────────────────────── */}
        <h2>TABLE OF CONTENTS</h2>
        <ol className="legal-toc">
          <li><a href="#cp-what">What are cookies?</a></li>
          <li><a href="#cp-why">Why do we use cookies?</a></li>
          <li><a href="#cp-control">How can I control cookies?</a></li>
          <li><a href="#cp-browser">How can I control cookies on my browser?</a></li>
          <li><a href="#cp-tracking">What about other tracking technologies, like web beacons?</a></li>
          <li><a href="#cp-flash">Do you use Flash cookies or Local Shared Objects?</a></li>
          <li><a href="#cp-targeted">Do you serve targeted advertising?</a></li>
          <li><a href="#cp-updates">How often will you update this Cookie Policy?</a></li>
          <li><a href="#cp-info">Where can I get further information?</a></li>
        </ol>

        {/* ── 1. WHAT ARE COOKIES? ───────────────────────────────────── */}
        <h2 id="cp-what">1. What are cookies?</h2>
        <p>
          Cookies are small data files that are placed on your computer or mobile device when you
          visit a website. Cookies are widely used by website owners in order to make their websites
          work, or to work more efficiently, as well as to provide reporting information.
        </p>
        <p>
          Cookies set by the website owner (in this case, Wired Wick Consulting LLC) are called
          &quot;first-party cookies.&quot; Cookies set by parties other than the website owner are
          called &quot;third-party cookies.&quot; Third-party cookies enable third-party features or
          functionality to be provided on or through the website (e.g., advertising, interactive
          content, and analytics). The parties that set these third-party cookies can recognize your
          computer both when it visits the website in question and also when it visits certain other
          websites.
        </p>

        {/* ── 2. WHY DO WE USE COOKIES? ──────────────────────────────── */}
        <h2 id="cp-why">2. Why do we use cookies?</h2>
        <p>
          We use first- and third-party cookies for several reasons. Some cookies are required for
          technical reasons in order for our Website to operate, and we refer to these as
          &quot;essential&quot; or &quot;strictly necessary&quot; cookies. Other cookies also enable
          us to track and target the interests of our users to enhance the experience on our
          Website. Third parties serve cookies through our Website for advertising, analytics, and
          other purposes. This is described in more detail below.
        </p>

        {/* ── 3. HOW CAN I CONTROL COOKIES? ──────────────────────────── */}
        <h2 id="cp-control">3. How can I control cookies?</h2>
        <p>
          You have the right to decide whether to accept or reject cookies. You can exercise your
          cookie rights by setting your preferences in the Cookie Consent Manager. The Cookie
          Consent Manager allows you to select which categories of cookies you accept or reject.
          Essential cookies cannot be rejected as they are strictly necessary to provide you with
          services.
        </p>
        <p>
          The Cookie Consent Manager can be found in the notification banner and on our Website. If
          you choose to reject cookies, you may still use our Website though your access to some
          functionality and areas of our Website may be restricted. You may also set or amend your
          web browser controls to accept or refuse cookies.
        </p>

        {/* ── 4. HOW CAN I CONTROL COOKIES ON MY BROWSER? ────────────── */}
        <h2 id="cp-browser">4. How can I control cookies on my browser?</h2>
        <p>
          As the means by which you can refuse cookies through your web browser controls vary from
          browser to browser, you should visit your browser&apos;s help menu for more information.
          The following is information about how to manage cookies on the most popular browsers:
        </p>
        <ul>
          <li>
            <a href="https://support.google.com/chrome/answer/95647#zippy=%2Callow-or-block-cookies" target="_blank" rel="noopener noreferrer">
              Chrome
            </a>
          </li>
          <li>
            <a href="https://support.microsoft.com/en-us/windows/delete-and-manage-cookies-168dab11-0753-043d-7c16-ede5947fc64d" target="_blank" rel="noopener noreferrer">
              Internet Explorer
            </a>
          </li>
          <li>
            <a href="https://support.mozilla.org/en-US/kb/enhanced-tracking-protection-firefox-desktop" target="_blank" rel="noopener noreferrer">
              Firefox
            </a>
          </li>
          <li>
            <a href="https://support.apple.com/en-ie/guide/safari/sfri11471/mac" target="_blank" rel="noopener noreferrer">
              Safari
            </a>
          </li>
          <li>
            <a href="https://support.microsoft.com/en-us/windows/microsoft-edge-browsing-data-and-privacy-bb8174ba-9d73-dcf2-9b4a-c582b4e640dd" target="_blank" rel="noopener noreferrer">
              Edge
            </a>
          </li>
          <li>
            <a href="https://help.opera.com/en/latest/web-preferences/" target="_blank" rel="noopener noreferrer">
              Opera
            </a>
          </li>
        </ul>
        <p>
          In addition, most advertising networks offer you a way to opt out of targeted advertising.
          If you would like to find out more information, please visit:
        </p>
        <ul>
          <li>
            <a href="http://www.aboutads.info/choices/" target="_blank" rel="noopener noreferrer">
              Digital Advertising Alliance
            </a>
          </li>
          <li>
            <a href="https://youradchoices.ca/" target="_blank" rel="noopener noreferrer">
              Digital Advertising Alliance of Canada
            </a>
          </li>
          <li>
            <a href="http://www.youronlinechoices.com/" target="_blank" rel="noopener noreferrer">
              European Interactive Digital Advertising Alliance
            </a>
          </li>
        </ul>

        {/* ── 5. OTHER TRACKING TECHNOLOGIES ─────────────────────────── */}
        <h2 id="cp-tracking">5. What about other tracking technologies, like web beacons?</h2>
        <p>
          Cookies are not the only way to recognize or track visitors to a website. We may use other,
          similar technologies from time to time, like web beacons (sometimes called &quot;tracking
          pixels&quot; or &quot;clear gifs&quot;). These are tiny graphics files that contain a
          unique identifier that enables us to recognize when someone has visited our Website or
          opened an email including them. This allows us, for example, to monitor the traffic
          patterns of users from one page within a website to another, to deliver or communicate
          with cookies, to understand whether you have come to the website from an online
          advertisement displayed on a third-party website, to improve site performance, and to
          measure the success of email marketing campaigns. In many instances, these technologies
          are reliant on cookies to function properly, and so declining cookies will impair their
          functioning.
        </p>

        {/* ── 6. FLASH COOKIES ───────────────────────────────────────── */}
        <h2 id="cp-flash">6. Do you use Flash cookies or Local Shared Objects?</h2>
        <p>
          Websites may also use so-called &quot;Flash Cookies&quot; (also known as Local Shared
          Objects or &quot;LSOs&quot;) to, among other things, collect and store information about
          your use of our services, fraud prevention, and for other site operations.
        </p>
        <p>
          If you do not want Flash Cookies stored on your computer, you can adjust the settings of
          your Flash player to block Flash Cookies storage using the tools contained in the Website
          Storage Settings Panel. You can also control Flash Cookies by going to the Global Storage
          Settings Panel and following the instructions (which may include instructions that explain,
          for example, how to delete existing Flash Cookies, how to prevent Flash LSOs from being
          placed on your computer without your being asked, and how to block Flash Cookies that are
          not being delivered by the operator of the page you are on at the time).
        </p>
        <p>
          Please note that setting the Flash Player to restrict or limit acceptance of Flash Cookies
          may reduce or impede the functionality of some Flash applications, including, potentially,
          Flash applications used in connection with our services or online content.
        </p>

        {/* ── 7. TARGETED ADVERTISING ────────────────────────────────── */}
        <h2 id="cp-targeted">7. Do you serve targeted advertising?</h2>
        <p>
          Third parties may serve cookies on your computer or mobile device to serve advertising
          through our Website. These companies may use information about your visits to this and
          other websites in order to provide relevant advertisements about goods and services that
          you may be interested in. They may also employ technology that is used to measure the
          effectiveness of advertisements. They can accomplish this by using cookies or web beacons
          to collect information about your visits to this and other sites in order to provide
          relevant advertisements about goods and services of potential interest to you. The
          information collected through this process does not enable us or them to identify your
          name, contact details, or other details that directly identify you unless you choose to
          provide these.
        </p>

        {/* ── 8. UPDATES ─────────────────────────────────────────────── */}
        <h2 id="cp-updates">8. How often will you update this Cookie Policy?</h2>
        <p>
          We may update this Cookie Policy from time to time in order to reflect, for example,
          changes to the cookies we use or for other operational, legal, or regulatory reasons.
          Please therefore revisit this Cookie Policy regularly to stay informed about our use of
          cookies and related technologies.
        </p>
        <p>
          The date at the top of this Cookie Policy indicates when it was last updated.
        </p>

        {/* ── 9. CONTACT ─────────────────────────────────────────────── */}
        <h2 id="cp-info">9. Where can I get further information?</h2>
        <p>
          If you have any questions about our use of cookies or other technologies, please email us
          at{" "}
          <a href="mailto:wickopsmanager@gmail.com">wickopsmanager@gmail.com</a> or by post to:
        </p>
        <div className="legal-contact">
          <p><strong>Wired Wick Consulting LLC</strong></p>
          <p>407 St Mary Dr</p>
          <p>Stevensville, MT 59870</p>
          <p>United States</p>
          <p>Phone: (530)613-9910</p>
        </div>
      </div>
    </div>
  );
}
