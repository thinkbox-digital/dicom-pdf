package digital.thinkbox.dicompdf;

import digital.thinkbox.pdfsecurity.CertificatePolicy;
import digital.thinkbox.pdfsecurity.C2pa;
import digital.thinkbox.pdfsecurity.PdfCmsVerification;
import digital.thinkbox.pdfsecurity.PdfValidationStore;
import digital.thinkbox.pdfsecurity.SecurityReport;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.cert.CertificateFactory;
import java.security.cert.TrustAnchor;
import java.security.cert.X509Certificate;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiFunction;
import java.util.function.Consumer;
import java.util.function.Supplier;
import javafx.animation.KeyFrame;
import javafx.animation.Timeline;
import javafx.application.Platform;
import javafx.concurrent.Task;
import javafx.geometry.Bounds;
import javafx.geometry.Pos;
import javafx.scene.Node;
import javafx.scene.Parent;
import javafx.scene.control.Button;
import javafx.scene.control.CheckBox;
import javafx.scene.control.ContextMenu;
import javafx.scene.control.Control;
import javafx.scene.control.Label;
import javafx.scene.control.MenuItem;
import javafx.scene.control.ScrollPane;
import javafx.scene.control.TextField;
import javafx.scene.control.TextInputControl;
import javafx.scene.control.ToggleButton;
import javafx.scene.input.MouseButton;
import javafx.scene.input.MouseEvent;
import javafx.scene.layout.BorderPane;
import javafx.scene.layout.FlowPane;
import javafx.scene.layout.HBox;
import javafx.scene.layout.Priority;
import javafx.scene.layout.StackPane;
import javafx.scene.layout.VBox;
import javafx.stage.Stage;
import javafx.util.Duration;

final class DesktopViewerSecurityReport extends StackPane {
    private record Result(DesktopViewerReportData.Checksums inventory, Map<String, SecurityReport.Check> authentication,
                          C2pa.ViewerEvidence credentials, FileState file, java.time.Instant checkedAt, long milliseconds) {
        long signaturesChecked() {
            if (!authentication.containsKey("pdf.cryptographicSignature")) return 0;
            long timestamps = authentication.entrySet().stream().filter(check -> check.getKey().startsWith("pdf.timestamp.")
                    && check.getValue().code().contains("_DOCUMENT_TIMESTAMP_")).count();
            return Math.min(inventory.pdfSignatures(), 1 + timestamps);
        }
    }
    private record FileState(long size, java.nio.file.attribute.FileTime modified, Object fileKey) {}
    private record VerificationProgress(String message, DesktopViewerReportData.Checksums inventory) {}
    private record TrustedResult(Set<X509Certificate> certificates, boolean online, Result result) {}
    static final class Session {
        private final Path archive;
        private final boolean institutional;
        private final Consumer<String> reportStatus;
        private final Trust trust;
        private final java.util.concurrent.FutureTask<Result> initial;
        private volatile VerificationProgress progress = new VerificationProgress("Checking embedded file checksums…", null);
        private volatile TrustedResult latest;
        private boolean started;

        Session(DesktopViewerDocument document, Trust trust, Consumer<String> reportStatus) {
            archive = document.path;
            institutional = document.hasInstitutionalEvidence();
            this.trust = trust;
            this.reportStatus = reportStatus;
            initial = new java.util.concurrent.FutureTask<>(() -> {
                try {
                    var result = verify(startingCertificates, startingOnline, null);
                    publishStatus(DesktopViewerReportData.report(result.inventory(), result.authentication()).reportStatus());
                    return result;
                } catch (Exception failure) {
                    publishStatus("UNKNOWN");
                    throw failure;
                }
            });
        }

        private Set<X509Certificate> startingCertificates;
        private boolean startingOnline;

        synchronized void start() {
            if (started) return;
            started = true;
            startingCertificates = Set.copyOf(trust.certificates);
            startingOnline = trust.online;
            publishStatus("CHECKING");
            Thread.ofVirtual().name("dicom-archive-security").start(initial);
        }

        void cancel() { initial.cancel(true); }

        private void publishStatus(String status) {
            Platform.runLater(() -> {
                if (!initial.isCancelled()) reportStatus.accept(status);
            });
        }

        private Result initial() throws Exception {
            start();
            try { return initial.get(); }
            catch (java.util.concurrent.ExecutionException error) {
                if (error.getCause() instanceof Exception failure) throw failure;
                throw new IOException("Archive security verification stopped unexpectedly.", error.getCause());
            }
        }

        Result result(Set<X509Certificate> certificates, boolean online) throws Exception {
            var base = initial();
            if (!base.file().equals(fileState(archive)))
                throw new IOException("The archive changed on disk. Reopen it to verify the current file.");
            if (startingOnline == online && startingCertificates.equals(certificates)) return base;
            var cached = latest;
            if (cached != null && cached.online() == online && cached.certificates().equals(certificates))
                return cached.result();
            var result = verify(certificates, online, base);
            latest = new TrustedResult(certificates, online, result);
            return result;
        }

        private Result verify(Set<X509Certificate> certificates, boolean online, Result previous) throws Exception {
            var file = fileState(archive);
            if (previous != null && !file.equals(previous.file()))
                throw new IOException("The archive changed on disk. Reopen it to verify the current file.");
            var inventory = previous == null ? DesktopViewerReportData.verify(archive, (checked, total) ->
                    progress = new VerificationProgress("Checking files: " + checked + " of " + total + ".", null))
                    : previous.inventory();
            if (previous == null) {
                int count = inventory.pdfSignatures();
                String pdfProgress = count == 0 ? "Checking PDF security…"
                        : "Checking " + count + (count == 1 ? " PDF signature" : " PDF signatures")
                        + (inventory.archival() ? " and saved revisions…" : "…");
                progress = new VerificationProgress(checksumStatus(inventory.checks()) + " " + pdfProgress, inventory);
            }
            long startedAt = System.nanoTime();
            var checkedAt = java.time.Instant.now();
            var anchors = certificates.stream().map(certificate -> new TrustAnchor(certificate, null))
                    .collect(java.util.stream.Collectors.toUnmodifiableSet());
            var policy = new CertificatePolicy(anchors, List.of(), checkedAt, List.of(), List.of(),
                    inventory.timestamped() && online ? trust.timestampAnchors() : Set.of());
            var checks = new LinkedHashMap<String, SecurityReport.Check>();
            var credentials = previous == null ? C2pa.verifyViewerEvidence(archive, ArchiveC2pa.FORMAT) : previous.credentials();
            checks.putAll(credentials.checks());
            if (!credentials.chain().isEmpty() && !credentials.localIdentity()) {
                var credentialPolicy = policy;
                try (var pdf = org.apache.pdfbox.Loader.loadPDF(archive.toFile())) {
                    var retained = PdfValidationStore.read(pdf);
                    if (retained != null) credentialPolicy = retained.augment(policy);
                } catch (Exception unreadable) {
                    // Trust can still be checked with the supplied anchors and embedded chain.
                }
                var credentialChecks = credentialPolicy.check(credentials.chain().getFirst(), credentials.chain());
                checks.put("c2pa.trust", credentialChecks.get("certificateTrust"));
                checks.put("c2pa.revocation", credentialChecks.get("revocation"));
            }
            if (institutional) checks.putAll(ArchiveSecurity.verifyViewerEvidence(archive, policy, stage -> {
                if (previous == null) progress = new VerificationProgress(stage, inventory);
            }).checks());
            else if (inventory.pdfSigned()) PdfCmsVerification.verify(archive, policy).forEach((key, value) -> checks.put("pdf." + key, value));
            if (!file.equals(fileState(archive))) throw new IOException("The archive changed during verification. Reopen it to verify the current file.");
            return new Result(inventory, java.util.Collections.unmodifiableMap(checks), credentials, file, checkedAt,
                    java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt));
        }
    }

    private static final class TimestampRoot {
        private static final TrustAnchor ANCHOR = load();

        private static TrustAnchor load() {
            try (var input = DesktopViewerSecurityReport.class.getResourceAsStream("/certificates/digicert-g4-timestamp.der")) {
                if (input == null) throw new IOException("Missing bundled DigiCert timestamp CA certificate.");
                var certificate = (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(input);
                return new TrustAnchor(certificate, null);
            } catch (IOException | java.security.cert.CertificateException failure) {
                throw new IllegalStateException("Could not load the bundled DigiCert timestamp CA certificate.", failure);
            }
        }
    }

    private static final int MAX_CERT_BYTES = 1024 * 1024;
    private static final com.google.gson.Gson JSON = new com.google.gson.GsonBuilder().setPrettyPrinting().create();

    static final class Trust {
        final Set<X509Certificate> certificates = new LinkedHashSet<>();
        boolean online = true;
        private java.time.Instant refreshAt = java.time.Instant.EPOCH;
        private Set<TrustAnchor> downloaded;

        synchronized Set<TrustAnchor> timestampAnchors() {
            if (java.time.Instant.now().isBefore(refreshAt)) return downloaded;
            var roots = new LinkedHashSet<TrustAnchor>();
            roots.add(TimestampRoot.ANCHOR);
            try {
                byte[] bytes = download(java.net.URI.create("https://raw.githubusercontent.com/c2pa-org/conformance-public/refs/heads/main/trust-list/C2PA-TSA-TRUST-LIST.pem"));
                try (var input = new java.io.ByteArrayInputStream(bytes)) {
                    var list = readCAs(input);
                    if (list.size() > 63) throw new IOException("The timestamp trust list exceeds the certificate limit.");
                    for (var root : list) roots.add(new TrustAnchor(root, null));
                }
                refreshAt = java.time.Instant.now().plusSeconds(3600);
            } catch (Exception unavailable) {
                refreshAt = java.time.Instant.now().plusSeconds(60);
            }
            downloaded = Set.copyOf(roots);
            return downloaded;
        }
    }

    private record SelectedCertificate(String subject, String issuer, String sha256, String notBefore, String notAfter) {}
    private final Session session;
    private final Trust trust;
    private final StackPane host;
    private final Node opener;
    private final BorderPane panel = new BorderPane();
    private final Button closeButton = new Button("×");
    private final Button saveButton = new Button("Save report");
    private final Button chooseButton = new Button("Add certificates…");
    private final Button clearButton = new Button("Clear selection");
    private final Button loadButton = new Button("Load certificate");
    private final TextField urlField = new TextField();
    private final CheckBox online = new CheckBox("Get timestamp CA certificates online");
    private final Label integrityBadge = badge();
    private final Label trustBadge = badge();
    private final Label certificateCount = new Label();
    private final DesktopViewerReportText messageText = new DesktopViewerReportText("", "security-message");
    private final DesktopViewerReportText certificateText = new DesktopViewerReportText("", "security-message");
    private final VBox fileRows = new VBox(10), declarationRows = new VBox(10);
    private final VBox findingsPane = new VBox(16), certificatesPane = new VBox(8);
    private Map<String, String> shownFiles = Map.of(), shownDeclarations = Map.of();
    private List<DesktopViewerReportData.Row> shownFindings = List.of();
    private Set<X509Certificate> shownCertificates = Set.of();
    private List<DesktopViewerReportText> selection = List.of();
    private int anchorBlock, anchorOffset;
    private boolean selectingText;
    private final Timeline progressUpdates = new Timeline(new KeyFrame(Duration.millis(100), event -> refreshProgress()));
    private final BiFunction<String, String, Path> destination;
    private final Supplier<List<Path>> chooseCertificates;
    private final Consumer<String> viewerStatus;
    private final Map<String, String> files = new LinkedHashMap<>();
    private VerificationProgress lastProgress;
    private Task<Result> verification;
    private DesktopViewerReportData.Report report;
    private Result evidence;
    private Map<String, String> declarations = Map.of();
    private boolean readingCertificates;
    private boolean certificateError;
    private String certificateMessage = "";
    private String status = "CHECKING";
    private String trustStatus = "";
    private String message = "Checking embedded file checksums and available manifest signature…";

    DesktopViewerSecurityReport(Stage owner, Node opener, Session session, Trust trust,
                                BiFunction<String, String, Path> destination, Supplier<List<Path>> chooseCertificates,
                                Consumer<String> viewerStatus) {
        this.session = session;
        this.trust = trust;
        this.opener = opener;
        this.destination = destination;
        this.chooseCertificates = chooseCertificates;
        this.viewerStatus = viewerStatus;
        this.host = (StackPane) owner.getScene().getRoot();
        getStyleClass().add("selected-metadata-backdrop");
        setPickOnBounds(true);
        panel.getStyleClass().add("security-report");
        panel.setMinSize(0, 0);
        panel.maxWidthProperty().bind(javafx.beans.binding.Bindings.min(1000, host.widthProperty().subtract(32)));
        panel.maxHeightProperty().bind(javafx.beans.binding.Bindings.createDoubleBinding(() -> {
            double height = host.getHeight(), width = host.getWidth();
            return Math.min(height * (width <= 640 ? .90 : .85), height - (width <= 640 ? 20 : 32));
        }, host.widthProperty(), host.heightProperty()));
        panel.setTop(header());
        panel.setCenter(body());
        getChildren().add(panel);
        files.put("Original files", "Not fully checked");
        files.put("Package files", "Not checked");
        files.put("Manifest signature", "Verification pending");
        files.put("Acquisition authenticity", "Not established");
        progressUpdates.setCycleCount(Timeline.INDEFINITE);
        addEventFilter(MouseEvent.MOUSE_PRESSED, this::startSelection);
        addEventFilter(MouseEvent.MOUSE_DRAGGED, this::extendSelection);
        addEventFilter(MouseEvent.MOUSE_RELEASED, event -> selectingText = false);
        var copy = new MenuItem("Copy");
        copy.setOnAction(event -> copySelection());
        var context = new ContextMenu(copy);
        setOnContextMenuRequested(event -> {
            if (!selectedText().isEmpty() && !(event.getTarget() instanceof TextInputControl)) {
                context.show(panel, event.getScreenX(), event.getScreenY());
                event.consume();
            }
        });
    }

    private HBox header() {
        var filename = new DesktopViewerReportText(session.archive.getFileName().toString(), "security-filename");
        var title = new DesktopViewerReportText("Archive security report", "security-title");
        var heading = new VBox(4, title, filename);
        HBox.setHgrow(heading, Priority.ALWAYS);
        closeButton.getStyleClass().add("security-close");
        closeButton.setAccessibleText("Close validation report");
        closeButton.setOnAction(event -> close());
        saveButton.getStyleClass().add("security-primary");
        saveButton.setOnAction(event -> Platform.runLater(this::save));
        var actions = new HBox(8, saveButton, closeButton);
        actions.setAlignment(Pos.CENTER_RIGHT);
        var header = new HBox(16, heading, actions);
        header.getStyleClass().add("security-header");
        header.setAlignment(Pos.CENTER_LEFT);
        return header;
    }

    private ScrollPane body() {
        var summary = card(new FlowPane(6, 6, integrityBadge, trustBadge), messageText);
        var filesCard = card(new DesktopViewerReportText("Archive files", "security-heading"), fileRows);
        declarationRows.getStyleClass().add("security-declaration-detail");
        var declarationsCard = disclosure("Archive declarations", null, declarationRows);
        declarationsCard.getStyleClass().add("security-declarations");
        var content = new VBox(16, summary, trustCard(), filesCard, findingsPane, declarationsCard);
        content.getStyleClass().add("security-body");
        collapseIfEmpty(findingsPane);
        var scroll = new ScrollPane(content);
        scroll.getStyleClass().add("security-scroll");
        scroll.setFitToWidth(true);
        scroll.setHbarPolicy(ScrollPane.ScrollBarPolicy.NEVER);
        scroll.setFocusTraversable(false);
        return scroll;
    }

    private VBox trustCard() {
        var heading = new DesktopViewerReportText("Trusted certificates", "security-heading");
        HBox.setHgrow(heading, Priority.ALWAYS);
        certificateCount.getStyleClass().add("security-count");
        var trustTitle = new HBox(10, heading, certificateCount);
        trustTitle.setAlignment(Pos.CENTER_LEFT);
        var help = new DesktopViewerReportText(
                "Supply the export signer’s public CA certificate from a file or an approved HTTPS site. The selection stays in this viewer.",
                "security-message");
        chooseButton.getStyleClass().add("security-primary");
        chooseButton.setOnAction(event -> Platform.runLater(this::selectCertificates));
        clearButton.setOnAction(event -> clearCertificates());
        urlField.setPromptText("https://");
        urlField.textProperty().addListener((property, before, value) -> updateCertificateControls());
        loadButton.setOnAction(event -> loadCertificate(urlField.getText()));
        urlField.setOnAction(event -> {
            if (!loadButton.isDisabled()) loadButton.fire();
        });
        var urlLabel = new Label("Signing CA certificate URL");
        urlLabel.getStyleClass().add("security-field-label");
        urlLabel.setLabelFor(urlField);
        HBox.setHgrow(urlField, Priority.ALWAYS);
        var urlForm = new VBox(6, urlLabel, new HBox(8, urlField, loadButton));
        urlForm.getStyleClass().add("security-url-form");
        online.setSelected(trust.online);
        online.setOnAction(event -> toggleOnline(online.isSelected()));
        certificateText.managedProperty().bind(certificateText.visibleProperty());
        collapseIfEmpty(certificatesPane);
        return card(trustTitle, help, new FlowPane(8, 8, chooseButton, clearButton), urlForm, online,
                certificateText, certificatesPane);
    }

    private static VBox card(Node... children) {
        var box = new VBox(7, children);
        box.getStyleClass().add("security-card");
        return box;
    }

    private static Label badge() {
        var label = new Label();
        label.getStyleClass().add("security-badge");
        label.managedProperty().bind(label.visibleProperty());
        return label;
    }

    private static void setBadge(Label badge, String status, String text) {
        badge.setText(text);
        badge.setVisible(!text.isEmpty());
        for (String state : List.of("PASS", "FAIL", "UNKNOWN", "CHECKING")) {
            badge.pseudoClassStateChanged(javafx.css.PseudoClass.getPseudoClass(state.toLowerCase(java.util.Locale.ROOT)),
                    state.equals(status));
        }
    }

    private static void collapseIfEmpty(VBox box) {
        box.visibleProperty().bind(javafx.beans.binding.Bindings.isNotEmpty(box.getChildren()));
        box.managedProperty().bind(box.visibleProperty());
    }

    private static VBox disclosure(String title, DesktopViewerReportData.Row row, Node details) {
        var caret = new Label("›");
        caret.getStyleClass().add("security-chevron");
        var summary = new ToggleButton(title, caret);
        summary.getStyleClass().add("security-disclosure");
        summary.setAccessibleText(title);
        summary.setWrapText(true);
        summary.setMaxWidth(Double.MAX_VALUE);
        var header = new StackPane(summary);
        if (row != null && !row.status().isEmpty()) {
            var state = badge();
            setBadge(state, row.status(), switch (row.status()) {
                case "PASS" -> "Passed";
                case "FAIL" -> "Failed";
                case "UNKNOWN" -> "Incomplete";
                default -> "Not applicable";
            });
            StackPane.setAlignment(state, Pos.CENTER_RIGHT);
            StackPane.setMargin(state, new javafx.geometry.Insets(0, 13, 0, 0));
            state.setMouseTransparent(true);
            state.setMaxSize(javafx.scene.layout.Region.USE_PREF_SIZE, javafx.scene.layout.Region.USE_PREF_SIZE);
            header.getChildren().add(state);
            summary.getStyleClass().add("security-disclosure-status");
        }
        details.visibleProperty().bind(summary.selectedProperty());
        details.managedProperty().bind(details.visibleProperty());
        caret.rotateProperty().bind(javafx.beans.binding.Bindings.when(summary.selectedProperty()).then(90).otherwise(0));
        var item = new VBox(header, details);
        item.getStyleClass().add("security-row");
        return item;
    }

    private static void terms(VBox target, Map<String, String> values) {
        target.getChildren().setAll(values.entrySet().stream().map(entry -> new VBox(4,
                new DesktopViewerReportText(entry.getKey().toUpperCase(java.util.Locale.ROOT), "security-term"),
                new DesktopViewerReportText(entry.getValue(), "security-value"))).toList());
    }

    void show() {
        host.getChildren().add(this);
        closeButton.requestFocus();
        verify(false);
    }

    boolean isShowing() { return getParent() == host; }

    void traverseFocus(boolean backward) {
        var controls = new java.util.ArrayList<Control>();
        collectFocus(panel, controls);
        if (controls.isEmpty()) return;
        int index = controls.indexOf(getScene().getFocusOwner());
        int next = index < 0 ? (backward ? controls.size() - 1 : 0)
                : Math.floorMod(index + (backward ? -1 : 1), controls.size());
        controls.get(next).requestFocus();
    }

    private static void collectFocus(Node node, List<Control> controls) {
        if (!node.isVisible() || node.isDisabled()) return;
        if (node instanceof ScrollPane scroll) collectFocus(scroll.getContent(), controls);
        else if (node instanceof Control control && control.isFocusTraversable()) controls.add(control);
        else if (node instanceof Parent parent)
            for (Node child : parent.getChildrenUnmodifiable()) collectFocus(child, controls);
    }

    boolean copySelection() {
        if (getScene().getFocusOwner() instanceof TextInputControl) return false;
        String selected = selectedText();
        if (selected.isEmpty()) return false;
        var clipboard = new javafx.scene.input.ClipboardContent();
        clipboard.putString(selected);
        return javafx.scene.input.Clipboard.getSystemClipboard().setContent(clipboard);
    }

    boolean selectReportText() {
        if (getScene().getFocusOwner() instanceof TextInputControl) return false;
        clearSelection();
        var blocks = new java.util.ArrayList<DesktopViewerReportText>();
        collectText(panel, blocks);
        selection = blocks;
        for (var text : selection) text.setSelection(0, text.value().length());
        return true;
    }

    private String selectedText() {
        return String.join("\n", selection.stream().map(DesktopViewerReportText::selectedText)
                .filter(text -> !text.isEmpty()).toList());
    }

    private void startSelection(MouseEvent event) {
        if (event.getButton() != MouseButton.PRIMARY) return;
        clearSelection();
        if (!(event.getTarget() instanceof DesktopViewerReportText text)) return;
        var blocks = new java.util.ArrayList<DesktopViewerReportText>();
        collectText(panel, blocks);
        anchorBlock = blocks.indexOf(text);
        if (anchorBlock < 0) return;
        selection = blocks;
        anchorOffset = text.position(event.getSceneX(), event.getSceneY());
        selectingText = true;
        text.requestFocus();
        if (event.getClickCount() == 2) {
            var words = java.text.BreakIterator.getWordInstance();
            words.setText(text.value());
            int start = words.preceding(Math.min(anchorOffset + 1, text.value().length()));
            int end = words.following(anchorOffset);
            if (start >= 0 && end >= start) {
                text.setSelection(start, end);
                selectingText = false;
            }
        }
        event.consume();
    }

    private static void collectText(Node node, List<DesktopViewerReportText> blocks) {
        if (!node.isVisible()) return;
        if (node instanceof DesktopViewerReportText text) blocks.add(text);
        else if (node instanceof ScrollPane scroll) collectText(scroll.getContent(), blocks);
        else if (node instanceof Parent parent && !(node instanceof Control))
            for (Node child : parent.getChildrenUnmodifiable()) collectText(child, blocks);
    }

    private void extendSelection(MouseEvent event) {
        if (!selectingText || !event.isPrimaryButtonDown()) return;
        double x = event.getSceneX(), y = event.getSceneY();
        int block = anchorBlock;
        double distance = Double.POSITIVE_INFINITY;
        for (int i = 0; i < selection.size(); i++) {
            var text = selection.get(i);
            Bounds bounds = text.localToScene(text.getLayoutBounds());
            double separation = Math.max(0, Math.max(bounds.getMinY() - y, y - bounds.getMaxY()));
            if (separation < distance) {
                block = i;
                distance = separation;
            }
        }
        var target = selection.get(block);
        int offset = target.position(x, y);
        int first = Math.min(anchorBlock, block), last = Math.max(anchorBlock, block);
        for (int i = 0; i < selection.size(); i++) {
            var text = selection.get(i);
            if (i < first || i > last) text.setSelection(0, 0);
            else if (anchorBlock == block) text.setSelection(anchorOffset, offset);
            else text.setSelection(i == first ? (i == anchorBlock ? anchorOffset : offset) : 0,
                    i == last ? (i == anchorBlock ? anchorOffset : offset) : text.value().length());
        }
        event.consume();
    }

    private void clearSelection() {
        for (var text : selection) text.setSelection(0, 0);
        selection = List.of();
        selectingText = false;
    }

    void close() {
        if (!host.getChildren().remove(this)) return;
        progressUpdates.stop();
        if (verification != null) verification.cancel();
        opener.requestFocus();
    }

    private void verify(boolean rechecking) {
        if (verification != null) verification.cancel();
        boolean followInitial = !rechecking && trust.certificates.isEmpty() && trust.online;
        status = "CHECKING";
        message = rechecking ? "Rechecking certificate trust…" : "Checking embedded file checksums and available manifest signature…";
        if (followInitial) {
            refreshProgress();
            progressUpdates.play();
        } else progressUpdates.stop();
        var selected = Set.copyOf(trust.certificates);
        boolean online = trust.online;
        var task = new Task<Result>() {
            @Override protected Result call() throws Exception {
                return session.result(selected, online);
            }
        };
        verification = task;
        task.setOnSucceeded(event -> {
            if (verification != task || !isShowing()) return;
            progressUpdates.stop();
            evidence = task.getValue();
            report = DesktopViewerReportData.report(evidence.inventory(), evidence.authentication());
            display();
            session.publishStatus(report.reportStatus());
            render();
        });
        task.setOnFailed(event -> {
            if (verification != task || !isShowing()) return;
            progressUpdates.stop();
            status = "UNKNOWN";
            message = message(task.getException());
            report = null;
            session.publishStatus(status);
            render();
        });
        render();
        Thread.ofVirtual().start(task);
    }

    private void refreshProgress() {
        var current = session.progress;
        if (current == lastProgress) return;
        lastProgress = current;
        message = current.message();
        var inventory = current.inventory();
        if (inventory != null) {
            showFileCounts(inventory.matches("original"), inventory.count("original"), inventory.count("artifact"), inventory.checks());
            declarations = inventory.declarations();
        }
        render();
    }

    private void display() {
        status = report.reportStatus();
        trustStatus = DesktopViewerReportData.trustStatus(report);
        var detail = new StringBuilder(checksumStatus(report.checks()));
        long checked = evidence.signaturesChecked();
        int signatures = evidence.inventory().pdfSignatures();
        if (checked > 0) detail.append(checked == 1 && signatures == 1 ? " Checked 1 PDF signature."
                : " Checked " + checked + " of " + signatures + " PDF signatures.");
        detail.append(switch (DesktopViewerReportData.pdfStatus(report)) {
            case "PASS" -> " PDF integrity checks passed.";
            case "FAIL" -> " PDF security checks failed.";
            case "UNKNOWN" -> " PDF security checks are incomplete.";
            default -> " No PDF export protection was found.";
        });
        if (session.institutional && trust.certificates.isEmpty() && trustStatus.equals("UNKNOWN"))
            detail.append(" Add the signing organization’s trusted CA certificate to verify who signed the archive.");
        else if (evidence.credentials().localIdentity())
            detail.append(" A one-time certificate signed this archive. The exporter’s identity is unverified.");
        message = detail.toString();
        showFileCounts(report.matchedOriginals(), report.originals(),
                evidence.inventory().count("artifact"), report.checks());
        files.remove("Acquisition authenticity");
        files.put("Manifest signature", report.signingEvidence().get("Manifest signature"));
        if (report.checks().containsKey("signerCertificateBinding"))
            files.put("Signer certificate binding", "Matches the signed certificate reference and recorded fingerprint");
        var dates = report.checks().get("signerCertificateValidity");
        if (dates != null) files.put("Signer certificate dates", dates.status() == SecurityReport.Status.PASS
                ? "Within validity dates according to the viewer’s clock" : "Verification incomplete");
        files.put("Acquisition authenticity", "Not established");
        declarations = report.signingEvidence();
    }

    private void showFileCounts(long matched, long originalCount, long artifacts, Map<String, SecurityReport.Check> checks) {
        files.put("Original files", matched + " of " + originalCount + " match recorded checksums");
        files.put("Package files", switch (checks.get("generatedArtifacts").status()) {
            case PASS -> artifacts + " checksums match";
            case FAIL -> "Checksum mismatch or missing file";
            default -> "Not fully checked";
        });
    }

    private static String checksumStatus(Map<String, SecurityReport.Check> checks) {
        return switch (DesktopViewerReportData.integrity(checks)) {
            case "PASS" -> "Recorded file checksums match.";
            case "FAIL" -> "File integrity check failed.";
            default -> "File checks completed with gaps.";
        };
    }

    private void render() {
        setBadge(integrityBadge, status, switch (status) {
            case "PASS" -> "Integrity checks passed";
            case "FAIL" -> "Security checks failed";
            case "UNKNOWN" -> "Security checks incomplete";
            default -> "Checking";
        });
        setBadge(trustBadge, trustStatus, switch (trustStatus) {
            case "PASS" -> "Certificate trust passed";
            case "FAIL" -> "Certificate trust failed";
            case "UNKNOWN" -> "Certificate trust incomplete";
            default -> "";
        });
        messageText.setText(message);
        saveButton.setDisable(report == null || "CHECKING".equals(status));
        updateCertificateControls();
        certificateCount.setText(trust.certificates.isEmpty() ? "No CA certificates selected"
                : trust.certificates.size() + " selected");
        certificateText.setText(certificateMessage);
        certificateText.setVisible(!certificateMessage.isEmpty());
        certificateText.pseudoClassStateChanged(javafx.css.PseudoClass.getPseudoClass("error"), certificateError);
        var findings = report == null ? List.<DesktopViewerReportData.Row>of() : report.pdfSecurity();
        if (!shownFiles.equals(files) || !shownDeclarations.equals(declarations) || !shownFindings.equals(findings)
                || !shownCertificates.equals(trust.certificates)) clearSelection();
        if (!shownFiles.equals(files)) {
            terms(fileRows, files);
            shownFiles = Map.copyOf(files);
        }
        if (!shownDeclarations.equals(declarations)) {
            terms(declarationRows, declarations);
            shownDeclarations = Map.copyOf(declarations);
        }
        if (!shownFindings.equals(findings)) {
            findingsPane.getChildren().clear();
            for (String group : List.of("C2PA", "PAdES", "C2PA + PAdES", "CMS", "Certificate trust", "Other checks")) {
                var rows = findings.stream().filter(row -> group.equals(row.category())).toList();
                if (rows.isEmpty()) continue;
                var heading = new DesktopViewerReportText(group, "security-heading");
                HBox.setHgrow(heading, Priority.ALWAYS);
                long count = rows.stream().filter(row -> !row.status().isEmpty()).count();
                var label = new Label(count == 0 ? "" : count + (count == 1 ? " check" : " checks"));
                label.getStyleClass().add("security-count");
                var header = new HBox(10, heading, label);
                header.setAlignment(Pos.CENTER_LEFT);
                var list = new VBox();
                list.getStyleClass().add("security-group");
                list.getChildren().setAll(rows.stream().map(row -> disclosure(row.name(), row,
                        new DesktopViewerReportText(row.detail(), "security-detail"))).toList());
                for (int i = 1; i < list.getChildren().size(); i++) list.getChildren().get(i).getStyleClass().add("security-row-divider");
                findingsPane.getChildren().add(new VBox(6, header, list));
            }
            shownFindings = findings;
        }
        if (!shownCertificates.equals(trust.certificates)) {
            certificatesPane.getChildren().setAll(trust.certificates.stream().map(certificate -> {
                var details = describe(certificate);
                var certificateFields = new LinkedHashMap<String, String>();
                certificateFields.put("Issuer", details.issuer());
                certificateFields.put("SHA-256", details.sha256());
                certificateFields.put("Valid from", details.notBefore());
                certificateFields.put("Valid until", details.notAfter());
                var fields = new VBox(10);
                fields.getStyleClass().add("security-declaration-detail");
                terms(fields, certificateFields);
                return disclosure(details.subject(), null, fields);
            }).toList());
            shownCertificates = Set.copyOf(trust.certificates);
        }
    }

    private void updateCertificateControls() {
        chooseButton.setDisable(readingCertificates);
        clearButton.setDisable(readingCertificates || trust.certificates.isEmpty());
        urlField.setDisable(readingCertificates);
        loadButton.setDisable(readingCertificates || urlField.getText().isBlank());
    }

    private static SelectedCertificate describe(X509Certificate certificate) {
        try {
            return new SelectedCertificate(certificate.getSubjectX500Principal().getName(),
                    certificate.getIssuerX500Principal().getName(), SourceContent.of(certificate.getEncoded()).digest().sha256(),
                    certificate.getNotBefore().toInstant().toString(), certificate.getNotAfter().toInstant().toString());
        } catch (Exception error) {
            throw new IllegalStateException("Could not describe the CA certificate.", error);
        }
    }

    private void selectCertificates() {
        if (!isShowing() || readingCertificates) return;
        List<Path> selected = chooseCertificates.get();
        if (selected.isEmpty()) return;
        readCertificates(() -> {
            var certificates = new LinkedHashSet<X509Certificate>();
            for (var path : selected) try (var input = Files.newInputStream(path)) {
                certificates.addAll(readCAs(input));
            }
            return certificates;
        }, false);
    }

    private void clearCertificates() {
        if (!isShowing() || readingCertificates) return;
        trust.certificates.clear();
        certificateMessage = "";
        certificateError = false;
        verify(true);
    }

    private void loadCertificate(String url) {
        if (!isShowing() || readingCertificates) return;
        readCertificates(() -> {
            try (var input = fromApprovedSite(url.strip())) { return readCAs(input); }
        }, true);
    }

    private void toggleOnline(boolean enabled) {
        if (!isShowing() || trust.online == enabled) return;
        trust.online = enabled;
        verify(true);
    }

    private void save() {
        if (!isShowing() || report == null || "CHECKING".equals(status)) return;
        String contents = JSON.toJson(DesktopViewerReportData.export(report, evidence.inventory(),
                trust.certificates.stream().map(DesktopViewerSecurityReport::describe).toList(),
                evidence.checkedAt().toString(), evidence.file().size(), evidence.milliseconds(), evidence.signaturesChecked())) + "\n";
        var path = destination.apply("Save security report", "dicom-file-checks.json");
        if (path == null) return;
        task(() -> {
            DesktopViewerDocument.write(path, output -> output.write(contents.getBytes(StandardCharsets.UTF_8)));
            return path;
        }, saved -> viewerStatus.accept("Saved " + saved.getFileName()), error -> {
            message = message(error);
            render();
        });
    }

    private void readCertificates(java.util.concurrent.Callable<Set<X509Certificate>> work, boolean replace) {
        readingCertificates = true;
        certificateError = false;
        certificateMessage = replace ? "Downloading the signing CA certificate…" : "Reading CA certificates…";
        render();
        task(work, selected -> {
            if (!isShowing()) return;
            readingCertificates = false;
            certificateMessage = "";
            if (replace) trust.certificates.clear();
            trust.certificates.addAll(selected);
            verify(true);
        }, error -> {
            readingCertificates = false;
            certificateError = true;
            certificateMessage = message(error);
            render();
        });
    }

    private static Set<X509Certificate> readCAs(java.io.InputStream input) throws Exception {
        byte[] bytes = input.readNBytes(MAX_CERT_BYTES + 1);
        if (bytes.length > MAX_CERT_BYTES) throw new IOException("Certificate file exceeds 1 MiB.");
        var factory = CertificateFactory.getInstance("X.509");
        var result = factory.generateCertificates(new java.io.ByteArrayInputStream(bytes)).stream()
                .map(X509Certificate.class::cast).filter(certificate -> certificate.getBasicConstraints() >= 0)
                .collect(java.util.stream.Collectors.toUnmodifiableSet());
        if (result.isEmpty()) throw new IOException("No X.509 CA certificates found.");
        return result;
    }

    private static java.io.InputStream fromApprovedSite(String value) throws Exception {
        var uri = java.net.URI.create(value);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null
                || (uri.getPort() != -1 && uri.getPort() != 443) || uri.getFragment() != null
                || !Set.of("cacerts.digicert.com", "knowledge.digicert.com").contains(uri.getHost().toLowerCase(java.util.Locale.ROOT)))
            throw new IOException("Use an approved DigiCert HTTPS URL or add the CA certificate from a file.");
        return new java.io.ByteArrayInputStream(download(uri));
    }

    private static byte[] download(java.net.URI uri) throws IOException {
        var connection = (javax.net.ssl.HttpsURLConnection) uri.toURL().openConnection();
        connection.setConnectTimeout(4000);
        connection.setReadTimeout(4000);
        connection.setInstanceFollowRedirects(false);
        try {
            if (connection.getResponseCode() != 200 || connection.getContentLengthLong() > MAX_CERT_BYTES)
                throw new IOException("The certificate site did not return a certificate file.");
            try (var input = connection.getInputStream()) {
                byte[] bytes = input.readNBytes(MAX_CERT_BYTES + 1);
                if (bytes.length == 0 || bytes.length > MAX_CERT_BYTES) throw new IOException("Invalid certificate download size.");
                return bytes;
            }
        } finally {
            connection.disconnect();
        }
    }

    private static FileState fileState(Path archive) throws IOException {
        var attributes = Files.readAttributes(archive, java.nio.file.attribute.BasicFileAttributes.class);
        return new FileState(attributes.size(), attributes.lastModifiedTime(), attributes.fileKey());
    }

    private static <T> void task(java.util.concurrent.Callable<T> work, Consumer<T> complete, Consumer<Throwable> failed) {
        var task = new Task<T>() {
            @Override protected T call() throws Exception { return work.call(); }
        };
        task.setOnSucceeded(event -> complete.accept(task.getValue()));
        task.setOnFailed(event -> failed.accept(task.getException()));
        Thread.ofVirtual().start(task);
    }

    private static String message(Throwable error) {
        return java.util.Objects.toString(error.getMessage(), error.getClass().getSimpleName());
    }
}
