package org.freemadeira.visittracker;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Work media and exports, kept apart from the personal camera roll.
 *
 * capture: opens the phone's own camera app (standard capture intent) and tells it to
 *   save into Pictures/FREE Madeira/<folder>/ — its own album, outside the app, so it
 *   survives an app reinstall or uninstall.
 * saveExport: writes the export JSON to Documents/FREE Madeira/exports/, where
 *   `pnpm sync` on the PC pulls it over adb.
 *
 * Android 10+ only (MediaStore relative paths); older versions reject with a message.
 */
@CapacitorPlugin(name = "FieldMedia")
public class FieldMediaPlugin extends Plugin {

    private static final String ROOT = "FREE Madeira";

    private Uri pendingUri;
    private String pendingPath;

    private boolean supported(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Needs Android 10 or newer.");
            return false;
        }
        return true;
    }

    @PluginMethod
    public void capture(PluginCall call) {
        if (!supported(call)) return;
        String kind = call.getString("kind", "photo");
        String folder = safe(call.getString("folder", "misc"));
        String name = safe(call.getString("filename", "capture"));
        boolean video = "video".equals(kind);

        String relativePath = "Pictures/" + ROOT + "/" + folder;
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name + (video ? ".mp4" : ".jpg"));
        v.put(MediaStore.MediaColumns.MIME_TYPE, video ? "video/mp4" : "image/jpeg");
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath);

        Uri collection = video
                ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                : MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        Uri uri = getContext().getContentResolver().insert(collection, v);
        if (uri == null) {
            call.reject("Couldn't create the file in " + relativePath);
            return;
        }
        pendingUri = uri;
        pendingPath = relativePath + "/" + name + (video ? ".mp4" : ".jpg");

        Intent intent = new Intent(video ? MediaStore.ACTION_VIDEO_CAPTURE : MediaStore.ACTION_IMAGE_CAPTURE);
        intent.putExtra(MediaStore.EXTRA_OUTPUT, uri);
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivityForResult(call, intent, "captureResult");
        } catch (Exception e) {
            discardPending();
            call.reject("No camera app found: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void captureResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || pendingUri == null || isEmpty(pendingUri)) {
            discardPending();
            JSObject r = new JSObject();
            r.put("saved", false);
            call.resolve(r);
            return;
        }
        JSObject r = new JSObject();
        r.put("saved", true);
        r.put("path", pendingPath);
        pendingUri = null;
        pendingPath = null;
        call.resolve(r);
    }

    @PluginMethod
    public void saveExport(PluginCall call) {
        if (!supported(call)) return;
        String name = safe(call.getString("filename", "export")) + ".json";
        String json = call.getString("json");
        if (json == null) {
            call.reject("Nothing to export.");
            return;
        }
        String relativePath = "Documents/" + ROOT + "/exports";
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, "application/json");
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath);
        ContentResolver cr = getContext().getContentResolver();
        Uri uri = cr.insert(MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
        if (uri == null) {
            call.reject("Couldn't create the export file.");
            return;
        }
        try (OutputStream out = cr.openOutputStream(uri)) {
            if (out == null) throw new Exception("no output stream");
            out.write(json.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            cr.delete(uri, null, null);
            call.reject("Export failed: " + e.getMessage());
            return;
        }
        JSObject r = new JSObject();
        r.put("path", relativePath + "/" + name);
        call.resolve(r);
    }

    /**
     * Opens a URL in whatever app handles it: a geo: URI shows the navigation-app chooser
     * (Organic Maps, Google Maps…), an https Google Maps link opens Google Maps.
     */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null) {
            call.reject("No URL.");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Intent launch = url.startsWith("geo:") ? Intent.createChooser(intent, "Navigate with") : intent;
        try {
            getContext().startActivity(launch);
            call.resolve();
        } catch (Exception e) {
            call.reject("No app can open this: " + e.getMessage());
        }
    }

    /** A camera app that returns OK without writing leaves a 0-byte entry. */
    private boolean isEmpty(Uri uri) {
        try (android.database.Cursor c = getContext().getContentResolver()
                .query(uri, new String[]{MediaStore.MediaColumns.SIZE}, null, null, null)) {
            return c == null || !c.moveToFirst() || c.getLong(0) == 0;
        } catch (Exception e) {
            return false;
        }
    }

    private void discardPending() {
        if (pendingUri != null) {
            try {
                getContext().getContentResolver().delete(pendingUri, null, null);
            } catch (Exception ignored) {
                // the camera app may already have removed it
            }
        }
        pendingUri = null;
        pendingPath = null;
    }

    /** Folder and file names: keep letters, digits, dash, underscore, dot. */
    private static String safe(String s) {
        String out = s == null ? "" : s.replaceAll("[^A-Za-z0-9._-]+", "-").replaceAll("^-+|-+$", "");
        return out.isEmpty() ? "x" : out;
    }
}
