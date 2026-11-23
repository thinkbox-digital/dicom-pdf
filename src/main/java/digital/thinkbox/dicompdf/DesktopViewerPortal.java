/* Adapted from the EA-PDF Desktop Viewer. Copyright 2026 ThinkBox Digital.
 * SPDX-License-Identifier: Apache-2.0
 */
package digital.thinkbox.dicompdf;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;

import org.freedesktop.dbus.DBusPath;
import org.freedesktop.dbus.annotations.DBusInterfaceName;
import org.freedesktop.dbus.connections.IDisconnectCallback;
import org.freedesktop.dbus.connections.impl.DBusConnectionBuilder;
import org.freedesktop.dbus.exceptions.DBusException;
import org.freedesktop.dbus.interfaces.DBus;
import org.freedesktop.dbus.interfaces.DBusInterface;
import org.freedesktop.dbus.matchrules.DBusMatchRuleBuilder;
import org.freedesktop.dbus.messages.DBusSignal;
import org.freedesktop.dbus.types.UInt32;
import org.freedesktop.dbus.types.Variant;

final class DesktopViewerPortal {
    private static final String PORTAL = "org.freedesktop.portal.Desktop";
    private static final String DESKTOP_PATH = "/org/freedesktop/portal/desktop";

    private DesktopViewerPortal() {}

    static Path choose(String parentWindow, String title, String suggestedName, String filterName, List<String> patterns) throws IOException {
        var paths = choose(parentWindow, title, suggestedName, filterName, patterns, false);
        return paths.isEmpty() ? null : paths.getFirst();
    }

    static List<Path> chooseMultiple(String parentWindow, String title, String filterName, List<String> patterns) throws IOException {
        return choose(parentWindow, title, null, filterName, patterns, true);
    }

    private static List<Path> choose(String parentWindow, String title, String suggestedName, String filterName,
                                     List<String> patterns, boolean multiple) throws IOException {
        var unavailable = new CompletableFuture<DBusSignal>();
        var disconnect = new IDisconnectCallback() {
            @Override
            public void disconnectOnError(IOException failure) {
                unavailable.completeExceptionally(new IOException("Lost the desktop portal connection.", failure));
            }
        };
        try (var connection = DBusConnectionBuilder.forSessionBus()
                .withShared(false).withDisconnectCallback(disconnect).build()) {
            var bus = connection.getRemoteObject("org.freedesktop.DBus", "/org/freedesktop/DBus", DBus.class);
            if (!bus.NameHasOwner(PORTAL)) bus.StartServiceByName(PORTAL, new UInt32(0));
            String portalOwner = bus.GetNameOwner(PORTAL);
            var chooser = connection.getRemoteObject(portalOwner, DESKTOP_PATH, FileChooser.class, false);
            var pending = new ConcurrentHashMap<String, CompletableFuture<DBusSignal>>();
            var responses = DBusMatchRuleBuilder.create().withType("signal").withSender(portalOwner)
                    .withInterface("org.freedesktop.portal.Request").withMember("Response")
                    .withPathNamespace(DESKTOP_PATH + "/request").build();
            var ownerChanges = DBusMatchRuleBuilder.create().withType("signal").withSender("org.freedesktop.DBus")
                    .withInterface("org.freedesktop.DBus").withMember("NameOwnerChanged")
                    .withArg0123(0, portalOwner).build();

            // Subscribe on this connection before the method call. A response can arrive before its reply.
            try (var responseHandler = connection.addGenericSigHandler(responses, signal ->
                        pending.computeIfAbsent(signal.getPath(), path -> new CompletableFuture<>()).complete(signal));
                 var ownerHandler = connection.addGenericSigHandler(ownerChanges, signal ->
                        unavailable.completeExceptionally(new IOException("The desktop portal closed while choosing a file.")))) {
                var options = options(suggestedName, filterName, patterns);
                if (multiple) options.put("multiple", new Variant<>(true));
                DBusPath request = suggestedName == null
                        ? chooser.OpenFile(parentWindow, title, options)
                        : chooser.SaveFile(parentWindow, title, options);
                var response = pending.computeIfAbsent(request.getPath(), path -> new CompletableFuture<>());
                return selectedPaths((DBusSignal) CompletableFuture.anyOf(response, unavailable).get(), multiple);
            }
        } catch (InterruptedException failure) {
            Thread.currentThread().interrupt();
            throw new IOException("The desktop file picker was interrupted.", failure);
        } catch (ExecutionException failure) {
            if (failure.getCause() instanceof IOException message) throw message;
            throw new IOException("The desktop file picker stopped unexpectedly.", failure);
        } catch (IOException failure) {
            throw failure;
        } catch (Exception failure) {
            throw new IOException("Could not use the desktop file picker. Check that the XDG Desktop Portal "
                    + "and a file chooser backend are available for this session.", failure);
        }
    }

    private static Map<String, Variant<?>> options(String suggestedName, String filterName, List<String> filters) {
        var options = new HashMap<String, Variant<?>>();
        options.put("handle_token", new Variant<>("dicom_pdf_" + UUID.randomUUID().toString().replace("-", "")));
        options.put("modal", new Variant<>(true));
        if (suggestedName == null) {
            var patterns = filters.stream().map(pattern -> new Object[]{new UInt32(0), pattern}).toList();
            options.put("filters", new Variant<>(List.<Object[]>of(new Object[]{filterName, patterns}), "a(sa(us))"));
        } else {
            options.put("current_name", new Variant<>(suggestedName));
        }
        return options;
    }

    private static List<Path> selectedPaths(DBusSignal response, boolean multiple) throws IOException, DBusException {
        var parameters = response.getParameters();
        if (parameters.length != 2 || !(parameters[0] instanceof UInt32 status)
                || !(parameters[1] instanceof Map<?, ?> results)) {
            throw new IOException("The desktop file picker returned an invalid response.");
        }
        if (status.intValue() == 1) return List.of();
        if (status.intValue() != 0) throw new IOException("The desktop file picker could not finish the request.");

        if (!(results.get("uris") instanceof Variant<?> uris)
                || !(uris.getValue() instanceof List<?> files) || files.isEmpty() || !multiple && files.size() != 1) {
            throw new IOException("The desktop file picker returned an invalid file selection.");
        }
        var paths = new java.util.ArrayList<Path>();
        for (var file : files) {
            if (!(file instanceof String address)) throw new IOException("The desktop file picker returned an invalid file selection.");
            try {
                URI uri = URI.create(address);
                if (!"file".equalsIgnoreCase(uri.getScheme()))
                    throw new IOException("The desktop file picker must return a local file.");
                paths.add(Path.of(uri));
            } catch (IllegalArgumentException failure) {
                throw new IOException("The desktop file picker returned an invalid local file path.", failure);
            }
        }
        return List.copyOf(paths);
    }

    @DBusInterfaceName("org.freedesktop.portal.FileChooser")
    public interface FileChooser extends DBusInterface {
        DBusPath OpenFile(String parentWindow, String title, Map<String, Variant<?>> options);

        DBusPath SaveFile(String parentWindow, String title, Map<String, Variant<?>> options);
    }
}
