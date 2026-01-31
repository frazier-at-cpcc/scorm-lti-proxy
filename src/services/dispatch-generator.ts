import AdmZip from 'adm-zip';

/**
 * Generates a thin SCORM 1.2 dispatch package
 * This package redirects to the hosted content on launch
 */
export async function generateDispatchPackage(
  courseTitle: string,
  launchUrl: string
): Promise<Buffer> {
  const zip = new AdmZip();

  // Generate imsmanifest.xml
  const manifest = generateManifest(courseTitle);
  zip.addFile('imsmanifest.xml', Buffer.from(manifest, 'utf-8'));

  // Generate launcher.html
  const launcher = generateLauncher(launchUrl);
  zip.addFile('launcher.html', Buffer.from(launcher, 'utf-8'));

  return zip.toBuffer();
}

/**
 * Generates SCORM 1.2 manifest for dispatch package
 */
function generateManifest(courseTitle: string): string {
  const safeTitle = escapeXml(courseTitle);
  const identifier = `dispatch_${Date.now()}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${identifier}"
          xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
          xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd
                              http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">

  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>

  <organizations default="org_1">
    <organization identifier="org_1">
      <title>${safeTitle}</title>
      <item identifier="item_1" identifierref="res_1">
        <title>${safeTitle}</title>
      </item>
    </organization>
  </organizations>

  <resources>
    <resource identifier="res_1" type="webcontent" adlcp:scormtype="sco" href="launcher.html">
      <file href="launcher.html"/>
    </resource>
  </resources>

</manifest>`;
}

/**
 * Generates launcher HTML that redirects to hosted content
 * Also provides a SCORM API wrapper that forwards calls to the parent LMS
 */
function generateLauncher(launchUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Loading Course...</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: #f5f5f5;
    }
    .loading {
      text-align: center;
    }
    .spinner {
      width: 40px;
      height: 40px;
      border: 4px solid #e0e0e0;
      border-top-color: #3498db;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="loading">
    <div class="spinner"></div>
    <p>Loading course content...</p>
  </div>

  <script>
    // Find the LMS API
    function findAPI(win) {
      var attempts = 0;
      while ((!win.API) && (win.parent) && (win.parent !== win) && (attempts < 10)) {
        attempts++;
        win = win.parent;
      }
      return win.API || null;
    }

    function findAPI_1484_11(win) {
      var attempts = 0;
      while ((!win.API_1484_11) && (win.parent) && (win.parent !== win) && (attempts < 10)) {
        attempts++;
        win = win.parent;
      }
      return win.API_1484_11 || null;
    }

    // Store reference to LMS API
    var lmsAPI = findAPI(window) || findAPI_1484_11(window);

    // Initialize with LMS
    if (lmsAPI) {
      if (lmsAPI.LMSInitialize) {
        lmsAPI.LMSInitialize('');
      } else if (lmsAPI.Initialize) {
        lmsAPI.Initialize('');
      }
    }

    // Build launch URL with learner info
    var launchUrl = '${escapeJs(launchUrl)}';

    // Add user identifier if available from LMS
    if (lmsAPI) {
      try {
        var studentId = lmsAPI.LMSGetValue ? lmsAPI.LMSGetValue('cmi.core.student_id') : null;
        if (!studentId && lmsAPI.GetValue) {
          studentId = lmsAPI.GetValue('cmi.learner_id');
        }
        if (studentId) {
          launchUrl += (launchUrl.indexOf('?') > -1 ? '&' : '?') + 'user_id=' + encodeURIComponent(studentId);
        }
      } catch (e) {
        console.log('Could not get student ID:', e);
      }
    }

    // Add session identifier
    launchUrl += (launchUrl.indexOf('?') > -1 ? '&' : '?') + 'session_id=' + Date.now();

    // Redirect to hosted content
    window.location.href = launchUrl;

    // Cleanup on unload
    window.onunload = function() {
      if (lmsAPI) {
        if (lmsAPI.LMSFinish) {
          lmsAPI.LMSFinish('');
        } else if (lmsAPI.Terminate) {
          lmsAPI.Terminate('');
        }
      }
    };
  </script>
</body>
</html>`;
}

/**
 * Escape special XML characters
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Escape for JavaScript string
 */
function escapeJs(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}
