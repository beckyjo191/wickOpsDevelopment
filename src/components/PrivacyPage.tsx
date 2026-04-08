import "./LandingPage.css";
import "./LegalPage.css";
import logoThumb from "../assets/brand/wickops-logo-thumb.svg";

export function PrivacyPage() {
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
        <h1>PRIVACY POLICY</h1>
        <p className="legal-subtitle"><strong>Last updated</strong> April 02, 2026</p>

        <p>
          This Privacy Notice for Wired Wick Consulting LLC (doing business as WickOps)
          (&quot;we,&quot; &quot;us,&quot; or &quot;our&quot;), describes how and why we might
          access, collect, store, use, and/or share (&quot;process&quot;) your personal information
          when you use our services (&quot;Services&quot;), including when you:
        </p>
        <ul>
          <li>
            Visit our website at{" "}
            <a href="https://systems.wickops.com" target="_blank" rel="noopener noreferrer">
              https://systems.wickops.com
            </a>{" "}
            or any website of ours that links to this Privacy Notice
          </li>
          <li>
            Use WickOps. WickOps is a cloud-based inventory management platform designed for fire
            departments and small organizations. It enables users to track inventory, log usage,
            manage reorders, monitor expiration dates, and generate activity reports through a
            web-based application accessible on desktop and mobile devices.
          </li>
          <li>
            Engage with us in other related ways, including any marketing or events
          </li>
        </ul>
        <p>
          <strong>Questions or concerns?</strong> Reading this Privacy Notice will help you
          understand your privacy rights and choices. We are responsible for making decisions about
          how your personal information is processed. If you do not agree with our policies and
          practices, please do not use our Services. If you still have any questions or concerns,
          please contact us at{" "}
          <a href="mailto:wickopsmanager@gmail.com">wickopsmanager@gmail.com</a>.
        </p>

        {/* ── SUMMARY OF KEY POINTS ──────────────────────────────────── */}
        <h2>SUMMARY OF KEY POINTS</h2>
        <p>
          <strong><em>
            This summary provides key points from our Privacy Notice, but you can find out more
            details about any of these topics by clicking the link following each key point or by
            using our table of contents below to find the section you are looking for.
          </em></strong>
        </p>
        <p>
          <strong>What personal information do we process?</strong> When you visit, use, or navigate
          our Services, we may process personal information depending on how you interact with us
          and the Services, the choices you make, and the products and features you use. Learn more
          about <a href="#pp-infocollect">personal information you disclose to us</a>.
        </p>
        <p>
          <strong>Do we process any sensitive personal information?</strong> We do not process
          sensitive personal information.
        </p>
        <p>
          <strong>Do we collect any information from third parties?</strong> We do not collect any
          information from third parties.
        </p>
        <p>
          <strong>How do we process your information?</strong> We process your information to
          provide, improve, and administer our Services, communicate with you, for security and
          fraud prevention, and to comply with law. We may also process your information for other
          purposes with your consent. We process your information only when we have a valid legal
          reason to do so. Learn more about{" "}
          <a href="#pp-infouse">how we process your information</a>.
        </p>
        <p>
          <strong>
            In what situations and with which parties do we share personal information?
          </strong>{" "}
          We may share information in specific situations and with specific third parties. Learn
          more about{" "}
          <a href="#pp-whoshare">when and with whom we share your personal information</a>.
        </p>
        <p>
          <strong>How do we keep your information safe?</strong> We have adequate organizational and
          technical processes and procedures in place to protect your personal information. However,
          no electronic transmission over the internet or information storage technology can be
          guaranteed to be 100% secure, so we cannot promise or guarantee that hackers,
          cybercriminals, or other unauthorized third parties will not be able to defeat our security
          and improperly collect, access, steal, or modify your information. Learn more about{" "}
          <a href="#pp-infosafe">how we keep your information safe</a>.
        </p>
        <p>
          <strong>What are your rights?</strong> Depending on where you are located geographically,
          the applicable privacy law may mean you have certain rights regarding your personal
          information. Learn more about <a href="#pp-privacyrights">your privacy rights</a>.
        </p>
        <p>
          <strong>How do you exercise your rights?</strong> The easiest way to exercise your rights
          is by submitting a data subject access request, or by contacting us. We will consider and
          act upon any request in accordance with applicable data protection laws.
        </p>
        <p>
          Want to learn more about what we do with any information we collect?{" "}
          <a href="#pp-toc">Review the Privacy Notice in full</a>.
        </p>

        {/* ── TABLE OF CONTENTS ──────────────────────────────────────── */}
        <h2 id="pp-toc">TABLE OF CONTENTS</h2>
        <ol className="legal-toc">
          <li><a href="#pp-infocollect">WHAT INFORMATION DO WE COLLECT?</a></li>
          <li><a href="#pp-infouse">HOW DO WE PROCESS YOUR INFORMATION?</a></li>
          <li><a href="#pp-whoshare">WHEN AND WITH WHOM DO WE SHARE YOUR PERSONAL INFORMATION?</a></li>
          <li><a href="#pp-cookies">DO WE USE COOKIES AND OTHER TRACKING TECHNOLOGIES?</a></li>
          <li><a href="#pp-inforetain">HOW LONG DO WE KEEP YOUR INFORMATION?</a></li>
          <li><a href="#pp-infosafe">HOW DO WE KEEP YOUR INFORMATION SAFE?</a></li>
          <li><a href="#pp-infominors">DO WE COLLECT INFORMATION FROM MINORS?</a></li>
          <li><a href="#pp-privacyrights">WHAT ARE YOUR PRIVACY RIGHTS?</a></li>
          <li><a href="#pp-dnt">CONTROLS FOR DO-NOT-TRACK FEATURES</a></li>
          <li><a href="#pp-uslaws">DO UNITED STATES RESIDENTS HAVE SPECIFIC PRIVACY RIGHTS?</a></li>
          <li><a href="#pp-policyupdates">DO WE MAKE UPDATES TO THIS NOTICE?</a></li>
          <li><a href="#pp-contact">HOW CAN YOU CONTACT US ABOUT THIS NOTICE?</a></li>
          <li><a href="#pp-request">HOW CAN YOU REVIEW, UPDATE, OR DELETE THE DATA WE COLLECT FROM YOU?</a></li>
        </ol>

        {/* ── 1. WHAT INFORMATION DO WE COLLECT? ─────────────────────── */}
        <h2 id="pp-infocollect">1. WHAT INFORMATION DO WE COLLECT?</h2>

        <h3>Personal information you disclose to us</h3>
        <p>
          <strong><em>In Short:</em></strong>{" "}
          <em>We collect personal information that you provide to us.</em>
        </p>
        <p>
          We collect personal information that you voluntarily provide to us when you register on
          the Services, express an interest in obtaining information about us or our products and
          Services, when you participate in activities on the Services, or otherwise when you
          contact us.
        </p>
        <p>
          <strong>Personal Information Provided by You.</strong> The personal information that we
          collect depends on the context of your interactions with us and the Services, the choices
          you make, and the products and features you use. The personal information we collect may
          include the following:
        </p>
        <ul>
          <li>names</li>
          <li>email addresses</li>
          <li>usernames</li>
          <li>passwords</li>
          <li>contact or authentication data</li>
        </ul>
        <p>
          <strong>Sensitive Information.</strong> We do not process sensitive information.
        </p>
        <p>
          <strong>Payment Data.</strong> We may collect data necessary to process your payment if
          you choose to make purchases, such as your payment instrument number, and the security
          code associated with your payment instrument. All payment data is handled and stored by
          Stripe. You may find their privacy notice link here:{" "}
          <a href="https://stripe.com/privacy" target="_blank" rel="noopener noreferrer">
            https://stripe.com/privacy
          </a>
          .
        </p>
        <p>
          All personal information that you provide to us must be true, complete, and accurate, and
          you must notify us of any changes to such personal information.
        </p>

        <h3>Information automatically collected</h3>
        <p>
          <strong><em>In Short:</em></strong>{" "}
          <em>
            Some information — such as your Internet Protocol (IP) address and/or browser and device
            characteristics — is collected automatically when you visit our Services.
          </em>
        </p>
        <p>
          We automatically collect certain information when you visit, use, or navigate the
          Services. This information does not reveal your specific identity (like your name or
          contact information) but may include device and usage information, such as your IP address,
          browser and device characteristics, operating system, language preferences, referring URLs,
          device name, country, location, information about how and when you use our Services, and
          other technical information. This information is primarily needed to maintain the security
          and operation of our Services, and for our internal analytics and reporting purposes.
        </p>
        <p>
          Like many businesses, we also collect information through cookies and similar technologies.
        </p>
        <p>The information we collect includes:</p>
        <ul>
          <li>
            <em>Log and Usage Data.</em> Log and usage data is service-related, diagnostic, usage,
            and performance information our servers automatically collect when you access or use our
            Services and which we record in log files. Depending on how you interact with us, this
            log data may include your IP address, device information, browser type, and settings and
            information about your activity in the Services (such as the date/time stamps associated
            with your usage, pages and files viewed, searches, and other actions you take such as
            which features you use), device event information (such as system activity, error reports
            (sometimes called &quot;crash dumps&quot;), and hardware settings).
          </li>
        </ul>

        {/* ── 2. HOW DO WE PROCESS YOUR INFORMATION? ─────────────────── */}
        <h2 id="pp-infouse">2. HOW DO WE PROCESS YOUR INFORMATION?</h2>
        <p>
          <strong><em>In Short:</em></strong>{" "}
          <em>
            We process your information to provide, improve, and administer our Services,
            communicate with you, for security and fraud prevention, and to comply with law. We may
            also process your information for other purposes with your consent.
          </em>
        </p>
        <p>
          <strong>
            We process your personal information for a variety of reasons, depending on how you
            interact with our Services, including:
          </strong>
        </p>
        <ul>
          <li>
            <strong>To facilitate account creation and authentication and otherwise manage user
            accounts.</strong> We may process your information so you can create and log in to your
            account, as well as keep your account in working order.
          </li>
          <li>
            <strong>To deliver and facilitate delivery of services to the user.</strong> We may
            process your information to provide you with the requested service.
          </li>
          <li>
            <strong>To respond to user inquiries/offer support to users.</strong> We may process
            your information to respond to your inquiries and solve any potential issues you might
            have with the requested service.
          </li>
          <li>
            <strong>To send administrative information to you.</strong> We may process your
            information to send you details about our products and services, changes to our terms
            and policies, and other similar information.
          </li>
          <li>
            <strong>To fulfill and manage your orders.</strong> We may process your information to
            fulfill and manage your orders, payments, returns, and exchanges made through the
            Services.
          </li>
          <li>
            <strong>To protect our Services.</strong> We may process your information as part of our
            efforts to keep our Services safe and secure, including fraud monitoring and prevention.
          </li>
          <li>
            <strong>To evaluate and improve our Services, products, marketing, and your
            experience.</strong> We may process your information when we believe it is necessary to
            identify usage trends, determine the effectiveness of our promotional campaigns, and to
            evaluate and improve our Services, products, marketing, and your experience.
          </li>
          <li>
            <strong>To identify usage trends.</strong> We may process information about how you use
            our Services to better understand how they are being used so we can improve them.
          </li>
          <li>
            <strong>To comply with our legal obligations.</strong> We may process your information
            to comply with our legal obligations, respond to legal requests, and exercise, establish,
            or defend our legal rights.
          </li>
        </ul>

        {/* ── 3. WHEN AND WITH WHOM DO WE SHARE? ─────────────────────── */}
        <h2 id="pp-whoshare">3. WHEN AND WITH WHOM DO WE SHARE YOUR PERSONAL INFORMATION?</h2>
        <p>
          <strong><em>In Short:</em></strong>{" "}
          <em>
            We may share information in specific situations described in this section and/or with
            the following third parties.
          </em>
        </p>
        <p>We may need to share your personal information in the following situations:</p>
        <ul>
          <li>
            <strong>Business Transfers.</strong> We may share or transfer your information in
            connection with, or during negotiations of, any merger, sale of company assets,
            financing, or acquisition of all or a portion of our business to another company.
          </li>
        </ul>

        {/* ── 4. DO WE USE COOKIES? ──────────────────────────────────── */}
        <h2 id="pp-cookies">4. DO WE USE COOKIES AND OTHER TRACKING TECHNOLOGIES?</h2>
        <p>
          <strong><em>In Short:</em></strong>{" "}
          <em>We may use cookies and other tracking technologies to collect and store your
          information.</em>
        </p>
        <p>
          We may use cookies and similar tracking technologies (like web beacons and pixels) to
          gather information when you interact with our Services. Some online tracking technologies
          help us maintain the security of our Services and your account, prevent crashes, fix bugs,
          save your preferences, and assist with basic site functions.
        </p>
        <p>
          We also permit third parties and service providers to use online tracking technologies on
          our Services for analytics and advertising, including to help manage and display
          advertisements, to tailor advertisements to your interests, or to send abandoned shopping
          cart reminders (depending on your communication preferences). The third parties and service
          providers use their technology to provide advertising about products and services tailored
          to your interests which may appear either on our Services or on other websites.
        </p>
        <p>
          To the extent these online tracking technologies are deemed to be a
          &quot;sale&quot;/&quot;sharing&quot; (which includes targeted advertising, as defined under
          the applicable laws) under applicable US state laws, you can opt out of these online
          tracking technologies by submitting a request as described below under section{" "}
          <a href="#pp-uslaws">DO UNITED STATES RESIDENTS HAVE SPECIFIC PRIVACY RIGHTS?</a>
        </p>

        {/* ── 5. HOW LONG DO WE KEEP YOUR INFORMATION? ───────────────── */}
        <h2 id="pp-inforetain">5. HOW LONG DO WE KEEP YOUR INFORMATION?</h2>
        <p>
          <strong><em>In Short:</em></strong>{" "}
          <em>
            We keep your information for as long as necessary to fulfill the purposes outlined in
            this Privacy Notice unless otherwise required by law.
          </em>
        </p>
        <p>
          We will only keep your personal information for as long as it is necessary for the
          purposes set out in this Privacy Notice, unless a longer retention period is required or
          permitted by law (such as tax, accounting, or other legal requirements). No purpose in
          this notice will require us keeping your personal information for longer than the period
          of time in which users have an account with us.
        </p>
        <p>
          When we have no ongoing legitimate business need to process your personal information, we
          will either delete or anonymize such information, or, if this is not possible (for
          example, because your personal information has been stored in backup archives), then we
          will securely store your personal information and isolate it from any further processing
          until deletion is possible.
        </p>

        {/* ── 6. HOW DO WE KEEP YOUR INFORMATION SAFE? ───────────────── */}
        <h2 id="pp-infosafe">6. HOW DO WE KEEP YOUR INFORMATION SAFE?</h2>
        <p>
          <strong><em>In Short:</em></strong>{" "}
          <em>
            We aim to protect your personal information through a system of organizational and
            technical security measures.
          </em>
        </p>
        <p>
          We have implemented appropriate and reasonable technical and organizational security
          measures designed to protect the security of any personal information we process. However,
          despite our safeguards and efforts to secure your information, no electronic transmission
          over the Internet or information storage technology can be guaranteed to be 100% secure,
          so we cannot promise or guarantee that hackers, cybercriminals, or other unauthorized
          third parties will not be able to defeat our security and improperly collect, access,
          steal, or modify your information. Although we will do our best to protect your personal
          information, transmission of personal information to and from our Services is at your own
          risk. You should only access the Services within a secure environment.
        </p>

        {/* ── 7. DO WE COLLECT INFORMATION FROM MINORS? ──────────────── */}
        <h2 id="pp-infominors">7. DO WE COLLECT INFORMATION FROM MINORS?</h2>
        <p>
          <strong><em>In Short:</em></strong>{" "}
          <em>We do not knowingly collect data from or market to children under 18 years of age.</em>
        </p>
        <p>
          We do not knowingly collect, solicit data from, or market to children under 18 years of
          age, nor do we knowingly sell such personal information. By using the Services, you
          represent that you are at least 18 or that you are the parent or guardian of such a minor
          and consent to such minor dependent&apos;s use of the Services. If we learn that personal
          information from users less than 18 years of age has been collected, we will deactivate
          the account and take reasonable measures to promptly delete such data from our records. If
          you become aware of any data we may have collected from children under age 18, please
          contact us at{" "}
          <a href="mailto:wickopsmanager@gmail.com">wickopsmanager@gmail.com</a>.
        </p>

        {/* ── 8. WHAT ARE YOUR PRIVACY RIGHTS? ───────────────────────── */}
        <h2 id="pp-privacyrights">8. WHAT ARE YOUR PRIVACY RIGHTS?</h2>
        <p>
          <strong><em>In Short:</em></strong>{" "}
          <em>
            You may review, change, or terminate your account at any time, depending on your
            country, province, or state of residence.
          </em>
        </p>

        <p>
          <strong><u>Withdrawing your consent:</u></strong> If we are relying on your consent to
          process your personal information, which may be express and/or implied consent depending
          on the applicable law, you have the right to withdraw your consent at any time. You can
          withdraw your consent at any time by contacting us by using the contact details provided
          in the section <a href="#pp-contact">HOW CAN YOU CONTACT US ABOUT THIS NOTICE?</a> below.
        </p>
        <p>
          However, please note that this will not affect the lawfulness of the processing before its
          withdrawal nor, when applicable law allows, will it affect the processing of your personal
          information conducted in reliance on lawful processing grounds other than consent.
        </p>

        <h3>Account Information</h3>
        <p>
          If you would at any time like to review or change the information in your account or
          terminate your account, you can:
        </p>
        <ul>
          <li>Contact us using the contact information provided.</li>
          <li>Log in to your account settings and update your user account.</li>
        </ul>
        <p>
          Upon your request to terminate your account, we will deactivate or delete your account
          and information from our active databases. However, we may retain some information in our
          files to prevent fraud, troubleshoot problems, assist with any investigations, enforce our
          legal terms and/or comply with applicable legal requirements.
        </p>
        <p>
          <strong><u>Cookies and similar technologies:</u></strong> Most Web browsers are set to
          accept cookies by default. If you prefer, you can usually choose to set your browser to
          remove cookies and to reject cookies. If you choose to remove cookies or reject cookies,
          this could affect certain features or services of our Services.
        </p>
        <p>
          If you have questions or comments about your privacy rights, you may email us at{" "}
          <a href="mailto:wickopsmanager@gmail.com">wickopsmanager@gmail.com</a>.
        </p>

        {/* ── 9. CONTROLS FOR DO-NOT-TRACK FEATURES ──────────────────── */}
        <h2 id="pp-dnt">9. CONTROLS FOR DO-NOT-TRACK FEATURES</h2>
        <p>
          Most web browsers and some mobile operating systems and mobile applications include a
          Do-Not-Track (&quot;DNT&quot;) feature or setting you can activate to signal your privacy
          preference not to have data about your online browsing activities monitored and collected.
          At this stage, no uniform technology standard for recognizing and implementing DNT signals
          has been finalized. As such, we do not currently respond to DNT browser signals or any
          other mechanism that automatically communicates your choice not to be tracked online. If a
          standard for online tracking is adopted that we must follow in the future, we will inform
          you about that practice in a revised version of this Privacy Notice.
        </p>
        <p>
          California law requires us to let you know how we respond to web browser DNT signals.
          Because there currently is not an industry or legal standard for recognizing or honoring
          DNT signals, we do not respond to them at this time.
        </p>

        {/* ── 10. DO UNITED STATES RESIDENTS HAVE SPECIFIC PRIVACY RIGHTS? ── */}
        <h2 id="pp-uslaws">10. DO UNITED STATES RESIDENTS HAVE SPECIFIC PRIVACY RIGHTS?</h2>
        <p>
          <strong><em>In Short:</em></strong>{" "}
          <em>
            If you are a resident of California, Colorado, Connecticut, Delaware, Florida, Indiana,
            Iowa, Kentucky, Maryland, Minnesota, Montana, Nebraska, New Hampshire, New Jersey,
            Oregon, Rhode Island, Tennessee, Texas, Utah, or Virginia, you may have the right to
            request access to and receive details about the personal information we maintain about
            you and how we have processed it, correct inaccuracies, get a copy of, or delete your
            personal information. You may also have the right to withdraw your consent to our
            processing of your personal information. These rights may be limited in some
            circumstances by applicable law. More information is provided below.
          </em>
        </p>

        <h3>Categories of Personal Information We Collect</h3>
        <p>
          The table below shows the categories of personal information we have collected in the past
          twelve (12) months. The table includes illustrative examples of each category and does not
          reflect the personal information we collect from you. For a comprehensive inventory of all
          personal information we process, please refer to the section{" "}
          <a href="#pp-infocollect">WHAT INFORMATION DO WE COLLECT?</a>
        </p>

        <table>
          <thead>
            <tr>
              <th>Category</th>
              <th>Examples</th>
              <th>Collected</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>A. Identifiers</td>
              <td>
                Contact details, such as real name, alias, postal address, telephone or mobile
                contact number, unique personal identifier, online identifier, Internet Protocol
                address, email address, and account name
              </td>
              <td>YES</td>
            </tr>
            <tr>
              <td>B. Personal information as defined in the California Customer Records statute</td>
              <td>Name, contact information, education, employment, employment history, and financial information</td>
              <td>YES</td>
            </tr>
            <tr>
              <td>C. Protected classification characteristics under state or federal law</td>
              <td>Gender, age, date of birth, race and ethnicity, national origin, marital status, and other demographic data</td>
              <td>NO</td>
            </tr>
            <tr>
              <td>D. Commercial information</td>
              <td>Transaction information, purchase history, financial details, and payment information</td>
              <td>YES</td>
            </tr>
            <tr>
              <td>E. Biometric information</td>
              <td>Fingerprints and voiceprints</td>
              <td>NO</td>
            </tr>
            <tr>
              <td>F. Internet or other similar network activity</td>
              <td>Browsing history, search history, online behavior, interest data, and interactions with our and other websites, applications, systems, and advertisements</td>
              <td>NO</td>
            </tr>
            <tr>
              <td>G. Geolocation data</td>
              <td>Device location</td>
              <td>NO</td>
            </tr>
            <tr>
              <td>H. Audio, electronic, sensory, or similar information</td>
              <td>Images and audio, video or call recordings created in connection with our business activities</td>
              <td>NO</td>
            </tr>
            <tr>
              <td>I. Professional or employment-related information</td>
              <td>Business contact details in order to provide you our Services at a business level or job title, work history, and professional qualifications if you apply for a job with us</td>
              <td>NO</td>
            </tr>
            <tr>
              <td>J. Education Information</td>
              <td>Student records and directory information</td>
              <td>NO</td>
            </tr>
            <tr>
              <td>K. Inferences drawn from collected personal information</td>
              <td>Inferences drawn from any of the collected personal information listed above to create a profile or summary about, for example, an individual&apos;s preferences and characteristics</td>
              <td>NO</td>
            </tr>
            <tr>
              <td>L. Sensitive personal Information</td>
              <td></td>
              <td>NO</td>
            </tr>
          </tbody>
        </table>

        <p>
          We will use and retain the collected personal information as needed to provide the
          Services or for:
        </p>
        <ul>
          <li>Category A - As long as the user has an account with us</li>
          <li>Category B - As long as the user has an account with us</li>
          <li>Category D - As long as the user has an account with us</li>
        </ul>

        <p>
          We may also collect other personal information outside of these categories through
          instances where you interact with us in person, online, or by phone or mail in the context
          of:
        </p>
        <ul>
          <li>Receiving help through our customer support channels;</li>
          <li>Participation in customer surveys or contests; and</li>
          <li>Facilitation in the delivery of our Services and to respond to your inquiries.</li>
        </ul>

        <h3>Sources of Personal Information</h3>
        <p>
          Learn more about the sources of personal information we collect in{" "}
          <a href="#pp-infocollect">WHAT INFORMATION DO WE COLLECT?</a>
        </p>

        <h3>How We Use and Share Personal Information</h3>
        <p>
          Learn more about how we use your personal information in the section,{" "}
          <a href="#pp-infouse">HOW DO WE PROCESS YOUR INFORMATION?</a>
        </p>
        <p>
          <strong>Will your information be shared with anyone else?</strong>
        </p>
        <p>
          We may disclose your personal information with our service providers pursuant to a written
          contract between us and each service provider. Learn more about how we disclose personal
          information to in the section,{" "}
          <a href="#pp-whoshare">WHEN AND WITH WHOM DO WE SHARE YOUR PERSONAL INFORMATION?</a>
        </p>
        <p>
          We may use your personal information for our own business purposes, such as for
          undertaking internal research for technological development and demonstration. This is not
          considered to be &quot;selling&quot; of your personal information.
        </p>
        <p>
          We have not disclosed, sold, or shared any personal information to third parties for a
          business or commercial purpose in the preceding twelve (12) months. We will not sell or
          share personal information in the future belonging to website visitors, users, and other
          consumers.
        </p>

        <h3>Your Rights</h3>
        <p>
          You have rights under certain US state data protection laws. However, these rights are not
          absolute, and in certain cases, we may decline your request as permitted by law. These
          rights include:
        </p>
        <ul>
          <li><strong>Right to know</strong> whether or not we are processing your personal data</li>
          <li><strong>Right to access</strong> your personal data</li>
          <li><strong>Right to correct</strong> inaccuracies in your personal data</li>
          <li><strong>Right to request</strong> the deletion of your personal data</li>
          <li><strong>Right to obtain a copy</strong> of the personal data you previously shared with us</li>
          <li><strong>Right to non-discrimination</strong> for exercising your rights</li>
          <li>
            <strong>Right to opt out</strong> of the processing of your personal data if it is used
            for targeted advertising (or sharing as defined under California&apos;s privacy law),
            the sale of personal data, or profiling in furtherance of decisions that produce legal
            or similarly significant effects (&quot;profiling&quot;)
          </li>
        </ul>
        <p>
          Depending upon the state where you live, you may also have the following rights:
        </p>
        <ul>
          <li>Right to access the categories of personal data being processed (as permitted by applicable law, including the privacy law in Minnesota)</li>
          <li>Right to obtain a list of the categories of third parties to which we have disclosed personal data (as permitted by applicable law, including the privacy law in California, Delaware, and Maryland)</li>
          <li>Right to obtain a list of specific third parties to which we have disclosed personal data (as permitted by applicable law, including the privacy law in Minnesota and Oregon)</li>
          <li>Right to obtain a list of third parties to which we have sold personal data (as permitted by applicable law, including the privacy law in Connecticut)</li>
          <li>Right to review, understand, question, and depending on where you live, correct how personal data has been profiled (as permitted by applicable law, including the privacy law in Connecticut and Minnesota)</li>
          <li>Right to limit use and disclosure of sensitive personal data (as permitted by applicable law, including the privacy law in California)</li>
          <li>Right to opt out of the collection of sensitive data and personal data collected through the operation of a voice or facial recognition feature (as permitted by applicable law, including the privacy law in Florida)</li>
        </ul>

        <h3>How to Exercise Your Rights</h3>
        <p>
          To exercise these rights, you can contact us by submitting a data subject access request,
          by emailing us at{" "}
          <a href="mailto:wickopsmanager@gmail.com">wickopsmanager@gmail.com</a>, or by referring
          to the contact details at the bottom of this document.
        </p>
        <p>
          Under certain US state data protection laws, you can designate an authorized agent to make
          a request on your behalf. We may deny a request from an authorized agent that does not
          submit proof that they have been validly authorized to act on your behalf in accordance
          with applicable laws.
        </p>

        <h3>Request Verification</h3>
        <p>
          Upon receiving your request, we will need to verify your identity to determine you are the
          same person about whom we have the information in our system. We will only use personal
          information provided in your request to verify your identity or authority to make the
          request. However, if we cannot verify your identity from the information already maintained
          by us, we may request that you provide additional information for the purposes of verifying
          your identity and for security or fraud-prevention purposes.
        </p>
        <p>
          If you submit the request through an authorized agent, we may need to collect additional
          information to verify your identity before processing your request and the agent will need
          to provide a written and signed permission from you to submit such request on your behalf.
        </p>

        <h3>Appeals</h3>
        <p>
          Under certain US state data protection laws, if we decline to take action regarding your
          request, you may appeal our decision by emailing us at{" "}
          <a href="mailto:wickopsmanager@gmail.com">wickopsmanager@gmail.com</a>. We will inform
          you in writing of any action taken or not taken in response to the appeal, including a
          written explanation of the reasons for the decisions. If your appeal is denied, you may
          submit a complaint to your state attorney general.
        </p>

        <h3>California &quot;Shine The Light&quot; Law</h3>
        <p>
          California Civil Code Section 1798.83, also known as the &quot;Shine The Light&quot; law,
          permits our users who are California residents to request and obtain from us, once a year
          and free of charge, information about categories of personal information (if any) we
          disclosed to third parties for direct marketing purposes and the names and addresses of
          all third parties with which we shared personal information in the immediately preceding
          calendar year. If you are a California resident and would like to make such a request,
          please submit your request in writing to us by using the contact details provided in the
          section <a href="#pp-contact">HOW CAN YOU CONTACT US ABOUT THIS NOTICE?</a>
        </p>

        {/* ── 11. DO WE MAKE UPDATES TO THIS NOTICE? ─────────────────── */}
        <h2 id="pp-policyupdates">11. DO WE MAKE UPDATES TO THIS NOTICE?</h2>
        <p>
          <strong><em>In Short:</em></strong>{" "}
          <em>Yes, we will update this notice as necessary to stay compliant with relevant laws.</em>
        </p>
        <p>
          We may update this Privacy Notice from time to time. The updated version will be indicated
          by an updated &quot;Revised&quot; date at the top of this Privacy Notice. If we make
          material changes to this Privacy Notice, we may notify you either by prominently posting a
          notice of such changes or by directly sending you a notification. We encourage you to
          review this Privacy Notice frequently to be informed of how we are protecting your
          information.
        </p>

        {/* ── 12. HOW CAN YOU CONTACT US ABOUT THIS NOTICE? ──────────── */}
        <h2 id="pp-contact">12. HOW CAN YOU CONTACT US ABOUT THIS NOTICE?</h2>
        <p>
          If you have questions or comments about this notice, you may email us at{" "}
          <a href="mailto:wickopsmanager@gmail.com">wickopsmanager@gmail.com</a> or contact us by
          post at:
        </p>
        <div className="legal-contact">
          <p><strong>Wired Wick Consulting LLC</strong></p>
          <p>407 St Mary Dr</p>
          <p>Stevensville, MT 59870</p>
          <p>United States</p>
        </div>

        {/* ── 13. HOW CAN YOU REVIEW, UPDATE, OR DELETE? ─────────────── */}
        <h2 id="pp-request">
          13. HOW CAN YOU REVIEW, UPDATE, OR DELETE THE DATA WE COLLECT FROM YOU?
        </h2>
        <p>
          Based on the applicable laws of your country or state of residence in the US, you may have
          the right to request access to the personal information we collect from you, details about
          how we have processed it, correct inaccuracies, or delete your personal information. You
          may also have the right to withdraw your consent to our processing of your personal
          information. These rights may be limited in some circumstances by applicable law. To
          request to review, update, or delete your personal information, please fill out and submit
          a data subject access request.
        </p>
      </div>
    </div>
  );
}
