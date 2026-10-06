package org.freemadeira.visittracker;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FieldMediaPlugin.class);
        registerPlugin(AmberSignerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
