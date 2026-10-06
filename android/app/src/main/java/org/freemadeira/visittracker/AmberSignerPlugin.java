package org.freemadeira.visittracker;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * NIP-55: talk to Amber (or any Android signer) on this phone directly — no relays,
 * no internet. Intents open the signer for approval; the Content Resolver answers in
 * the background once the user has ticked "remember" for that permission.
 */
@CapacitorPlugin(name = "AmberSigner")
public class AmberSignerPlugin extends Plugin {

    @PluginMethod
    public void isInstalled(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:"));
        boolean ok = !getContext().getPackageManager().queryIntentActivities(intent, 0).isEmpty();
        JSObject r = new JSObject();
        r.put("installed", ok);
        call.resolve(r);
    }

    /** get_public_key — the only request sent without a package. */
    @PluginMethod
    public void getPublicKey(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:"));
        intent.putExtra("type", "get_public_key");
        String permissions = call.getString("permissions");
        if (permissions != null) intent.putExtra("permissions", permissions);
        try {
            startActivityForResult(call, intent, "publicKeyResult");
        } catch (Exception e) {
            call.reject("No Android signer found (install Amber): " + e.getMessage());
        }
    }

    @ActivityCallback
    private void publicKeyResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            call.reject("The signer didn't answer.");
            return;
        }
        if (data.getBooleanExtra("rejected", false)) {
            call.reject("Rejected in the signer.");
            return;
        }
        String pubkey = data.getStringExtra("result");
        String pkg = data.getStringExtra("package");
        if (pubkey == null || pkg == null) {
            call.reject("The signer returned no public key.");
            return;
        }
        JSObject r = new JSObject();
        r.put("pubkey", pubkey);
        r.put("package", pkg);
        call.resolve(r);
    }

    /**
     * sign_event — Content Resolver first (silent, if remembered), else an intent. Takes
     * the unsigned event JSON (with pubkey and created_at) and returns the signed event.
     */
    @PluginMethod
    public void signEvent(PluginCall call) {
        String eventJson = call.getString("event");
        String currentUser = call.getString("currentUser");
        String pkg = call.getString("package");
        if (eventJson == null || currentUser == null || pkg == null) {
            call.reject("Missing event, currentUser or package.");
            return;
        }

        try (Cursor c = getContext().getContentResolver().query(
                Uri.parse("content://" + pkg + ".SIGN_EVENT"),
                new String[]{eventJson, "", currentUser}, null, null, null)) {
            if (c != null) {
                if (c.getColumnIndex("rejected") > -1) {
                    call.reject("Rejected in the signer.");
                    return;
                }
                int col = c.getColumnIndex("event");
                if (col > -1 && c.moveToFirst() && c.getString(col) != null) {
                    JSObject r = new JSObject();
                    r.put("event", c.getString(col));
                    call.resolve(r);
                    return;
                }
            }
        } catch (Exception ignored) {
            // not remembered: fall through to the intent
        }

        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:" + eventJson));
        intent.setPackage(pkg);
        intent.putExtra("type", "sign_event");
        intent.putExtra("current_user", currentUser);
        try {
            startActivityForResult(call, intent, "signResult");
        } catch (Exception e) {
            call.reject("Couldn't open the signer: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void signResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            call.reject("The signer didn't answer.");
            return;
        }
        if (data.getBooleanExtra("rejected", false)) {
            call.reject("Rejected in the signer.");
            return;
        }
        String event = data.getStringExtra("event");
        if (event == null) {
            call.reject("The signer returned no signed event.");
            return;
        }
        JSObject r = new JSObject();
        r.put("event", event);
        call.resolve(r);
    }

    /**
     * nip44_decrypt — Content Resolver first (silent, if remembered), else an intent that
     * opens the signer. A remembered "always reject" stops here without an intent.
     */
    @PluginMethod
    public void nip44Decrypt(PluginCall call) {
        String ciphertext = call.getString("ciphertext");
        String pubkey = call.getString("pubkey");
        String currentUser = call.getString("currentUser");
        String pkg = call.getString("package");
        if (ciphertext == null || pubkey == null || currentUser == null || pkg == null) {
            call.reject("Missing ciphertext, pubkey, currentUser or package.");
            return;
        }

        try (Cursor c = getContext().getContentResolver().query(
                Uri.parse("content://" + pkg + ".NIP44_DECRYPT"),
                new String[]{ciphertext, pubkey, currentUser}, null, null, null)) {
            if (c != null) {
                if (c.getColumnIndex("rejected") > -1) {
                    call.reject("Rejected in the signer.");
                    return;
                }
                int col = c.getColumnIndex("result");
                if (col > -1 && c.moveToFirst()) {
                    JSObject r = new JSObject();
                    r.put("plaintext", c.getString(col));
                    call.resolve(r);
                    return;
                }
            }
        } catch (Exception ignored) {
            // no remembered permission / provider unavailable: fall through to the intent
        }

        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:" + ciphertext));
        intent.setPackage(pkg);
        intent.putExtra("type", "nip44_decrypt");
        intent.putExtra("pubkey", pubkey);
        intent.putExtra("current_user", currentUser);
        try {
            startActivityForResult(call, intent, "decryptResult");
        } catch (Exception e) {
            call.reject("Couldn't open the signer: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void decryptResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null) {
            call.reject("The signer didn't answer.");
            return;
        }
        if (data.getBooleanExtra("rejected", false)) {
            call.reject("Rejected in the signer.");
            return;
        }
        String plaintext = data.getStringExtra("result");
        if (plaintext == null) {
            call.reject("The signer returned nothing.");
            return;
        }
        JSObject r = new JSObject();
        r.put("plaintext", plaintext);
        call.resolve(r);
    }
}
