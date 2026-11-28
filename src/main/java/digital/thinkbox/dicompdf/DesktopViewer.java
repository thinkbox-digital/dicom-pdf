package digital.thinkbox.dicompdf;

import static digital.thinkbox.dicompdf.DesktopViewerDocument.field;
import static digital.thinkbox.dicompdf.DesktopViewerDocument.number;

import java.io.File;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.StringJoiner;
import java.util.TreeMap;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import javafx.animation.KeyFrame;
import javafx.animation.Timeline;
import javafx.application.Application;
import javafx.application.Platform;
import javafx.beans.binding.Bindings;
import javafx.concurrent.Task;
import javafx.css.PseudoClass;
import javafx.embed.swing.SwingFXUtils;
import javafx.geometry.Insets;
import javafx.geometry.Pos;
import javafx.scene.Node;
import javafx.scene.Scene;
import javafx.scene.control.*;
import javafx.scene.image.Image;
import javafx.scene.image.ImageView;
import javafx.scene.input.KeyCode;
import javafx.scene.input.InputEvent;
import javafx.scene.input.KeyCodeCombination;
import javafx.scene.input.KeyCombination;
import javafx.scene.input.KeyEvent;
import javafx.scene.input.TransferMode;
import javafx.scene.layout.*;
import javafx.stage.FileChooser;
import javafx.stage.Stage;
import javafx.stage.WindowEvent;
import javafx.util.Duration;
import javax.imageio.ImageIO;

public final class DesktopViewer extends Application {
    private static final boolean LINUX = System.getProperty("os.name").equals("Linux");
    private static final String OPEN_FILTER = "DICOM and PDF files";
    private static final List<String> OPEN_PATTERNS =
            List.of("*.dcm", "*.DCM", "*.dicom", "*.DICOM", "*.ima", "*.IMA", "*.dic", "*.DIC", "*.pdf", "*.PDF");
    private enum ZipScope { SELECTED, SERIES, EXAM, ALL }
    private record Series(String modality, String description, String number, List<Manifest.Image> entries) {
        String summary() {
            long frames = entries.stream().mapToLong(entry -> Math.max(1, DesktopViewerDocument.number(entry, "NumberOfFrames", 1))).sum();
            return entries.size() + (entries.size() == 1 ? " file" : " files")
                    + (frames > entries.size() ? " · " + frames + " frames" : "")
                    + (number.isBlank() ? "" : " · Series " + number);
        }
    }
    private record Study(String date, String description, String area, String facility, List<Series> series) {
        @Override public String toString() { return date.isBlank() ? description : date + " · " + area; }
    }

    private final java.util.concurrent.ExecutorService reader = Executors.newSingleThreadExecutor(
            Thread.ofPlatform().name("dicom-viewer-reader").factory());
    private final BorderPane root = new BorderPane();
    private final StackPane metadataBackdrop = styled(new StackPane(), "selected-metadata-backdrop");
    private final SplitPane workspace = new SplitPane();
    private final HBox images = new HBox();
    private final VBox data = new VBox(7), details = new VBox();
    private final StackPane center = new StackPane();
    private final ListView<Manifest.Image> list = new ListView<>();
    private final ComboBox<Study> study = new ComboBox<>();
    private final javafx.collections.ObservableList<Series> studySeries = javafx.collections.FXCollections.observableArrayList();
    private final javafx.collections.transformation.FilteredList<Series> visibleSeries =
            new javafx.collections.transformation.FilteredList<>(studySeries);
    private final ListView<Series> series = new ListView<>(visibleSeries);
    private final Label studySummary = detailText("");
    private final Map<Series, javafx.beans.property.ObjectProperty<Image>> seriesThumbnails = new LinkedHashMap<>();
    private final Label count = new Label("Data  0"), status = new Label("Open a DICOM file or a DICOM PDF archive.");
    private final TextField seriesSearch = new TextField();
    private final Label profile = new Label("DICOM image profile");
    private final Button filename = new Button();
    private final Label localFilename = new Label("No file open");
    private final javafx.beans.property.BooleanProperty archiveMode = new javafx.beans.property.SimpleBooleanProperty();
    private final javafx.beans.property.BooleanProperty documentLoaded = new javafx.beans.property.SimpleBooleanProperty();
    private final Button metadataButton = new Button("Selected file metadata…");
    private final Button restoreData = new Button("›"), restoreDetails = new Button("‹");
    private final TabPane modes = new TabPane();
    private final Tab imageTab = new Tab("DICOM image"), pdfTab = new Tab("PDF reference"), specialTab = new Tab();
    private final Label sourceName = styled(new Label(), "source-name");
    private final Tab sourceNameTab = new Tab();
    private final VBox supporting = new VBox(5);
    private final Label supportingCount = styled(new Label("0"), "file-count");
    private final TitledPane supportingFiles = fileDisclosure("Other supplied files", supporting, supportingCount);
    private final Label inventory = new Label("Open a PDF to inspect its supplied files.");
    private final Button referenceDetails = button("Reference details…", this::showReferenceDetails);
    private final VBox archiveDetails = new VBox();
    private final Label pageCount = new Label("of 0");
    private final Spinner<Integer> pageNumber = new Spinner<>(1, 1, 1);
    private final ImageView reference = new ImageView();
    private final StackPane imageArea = new StackPane();
    private final Spinner<Integer> frameNumber = new Spinner<>(1, 1, 1);
    private final Spinner<Double> fps = new Spinner<>(0.1, 60, 10, 1);
    private final ComboBox<DesktopViewerDocument.Window> windows = new ComboBox<>();
    private final Slider position = new Slider(1, 2, 1);
    private final Slider brightness = new Slider(-100, 100, 0), contrast = new Slider(20, 500, 100);
    private final ToggleButton invert = new ToggleButton("Invert"), info = new ToggleButton("Info"), play = new ToggleButton("Play");
    private final Timeline cine = new Timeline();
    private Stage stage;
    private DesktopViewerCanvas viewport;
    private DesktopViewerDocument document;
    private Manifest.Image entry;
    private String interactiveDisplay = "Not checked";
    private Image shownImage;
    private double shownRatio;
    private int frame = 1, frames = 1;
    private final AtomicLong openRequest = new AtomicLong();
    private final AtomicLong displayRequest = new AtomicLong();
    private final AtomicLong pageRequest = new AtomicLong();
    private boolean updatingControls;
    private boolean opening;
    private boolean choosingFile;
    private boolean displayPending;
    private boolean resetOnDisplay;
    private DesktopViewerExport exportDialog;
    private DesktopViewerSecurityReport securityDialog;
    private final DesktopViewerSecurityReport.Trust securityTrust;
    private DesktopViewerSecurityReport.Session archiveSecurity;
    private String archiveReportStatus = "";
    private double dataWidth = 315, detailsWidth = 360;

    public DesktopViewer() {
        this(new DesktopViewerSecurityReport.Trust());
    }

    DesktopViewer(DesktopViewerSecurityReport.Trust trust) {
        securityTrust = trust;
    }

    public static void main(String[] args) { launch(args); }

    @Override public void start(Stage window) {
        var arguments = getParameters().getRaw();
        start(window, arguments.isEmpty() ? null : Path.of(arguments.getFirst()));
    }

    void start(Stage window, Path file) {
        stage = window;
        var icon = new Image(Objects.requireNonNull(DesktopViewer.class.getResource("/icons/icon-128.png"),
                "Missing desktop viewer icon").toExternalForm());
        viewport = new DesktopViewerCanvas(icon);
        imageArea.getChildren().setAll(viewport);

        var mark = new ImageView(icon);
        mark.setFitWidth(31);
        mark.setFitHeight(31);
        var name = styled(new Label(), "brand");
        name.textProperty().bind(javafx.beans.binding.Bindings.when(archiveMode).then("DICOM PDF Viewer").otherwise("DICOM Viewer"));
        var open = styled(button("Open File…", this::chooseFile), "primary");
        filename.setOnAction(event -> verify());
        filename.disableProperty().bind(documentLoaded.not());
        HBox.setHgrow(filename, Priority.ALWAYS);
        filename.setMaxWidth(Double.MAX_VALUE);
        filename.setMinWidth(0);
        filename.getStyleClass().add("document-name");
        HBox.setHgrow(localFilename, Priority.ALWAYS);
        localFilename.setMaxWidth(Double.MAX_VALUE);
        localFilename.setMinWidth(0);
        localFilename.visibleProperty().bind(archiveMode.not());
        localFilename.managedProperty().bind(localFilename.visibleProperty());
        var originalsZip = new Menu("Originals ZIP");
        originalsZip.getItems().setAll(item("Selected file…", () -> saveZip(ZipScope.SELECTED)),
                item("Current series…", () -> saveZip(ZipScope.SERIES)), item("Current exam…", () -> saveZip(ZipScope.EXAM)),
                item("All supplied files…", () -> saveZip(ZipScope.ALL)));
        var original = item("Original file", this::saveOriginal);
        original.visibleProperty().bind(archiveMode);
        originalsZip.visibleProperty().bind(archiveMode);
        var save = new MenuButton("Save", null, original, originalsZip, item("Image copy (PNG)", this::saveImage));
        save.disableProperty().bind(documentLoaded.not());
        var csv = button("Export metadata…", this::exportMetadata);
        var offline = styled(new Label("Offline"), "offline");
        offline.setGraphic(styled(new javafx.scene.shape.Circle(4), "offline-dot"));
        for (var archiveControl : List.of(filename, offline, csv, profile, archiveDetails)) {
            archiveControl.visibleProperty().bind(archiveMode);
            archiveControl.managedProperty().bind(archiveControl.visibleProperty());
        }
        root.setTop(row("header", mark, name, open, filename, localFilename, offline, save, csv));

        buildData();
        buildDetails();
        buildReader();
        workspace.getStyleClass().add("viewer-workspace");
        center.setMinWidth(215);
        center.setMaxWidth(Double.MAX_VALUE);
        data.setMaxWidth(Double.MAX_VALUE);
        details.setMaxWidth(Double.MAX_VALUE);
        workspace.getItems().addAll(data, center, details);
        workspace.setDividerPositions(.22, .75);
        SplitPane.setResizableWithParent(data, false);
        SplitPane.setResizableWithParent(details, false);
        root.setCenter(workspace);
        HBox.setHgrow(status, Priority.ALWAYS);
        status.setMaxWidth(Double.MAX_VALUE);
        root.setBottom(row("footer", status, profile, new Label("Viewer " + ApplicationVersion.VERSION)));

        metadataBackdrop.setVisible(false);
        metadataBackdrop.managedProperty().bind(metadataBackdrop.visibleProperty());
        metadataBackdrop.setMinSize(0, 0);
        metadataBackdrop.setPrefSize(0, 0);
        var scene = new Scene(new StackPane(root, metadataBackdrop), 1450, 880);
        name.visibleProperty().bind(scene.widthProperty().greaterThanOrEqualTo(1030));
        name.managedProperty().bind(name.visibleProperty());
        scene.getStylesheets().add(Objects.requireNonNull(DesktopViewer.class.getResource("/desktop-viewer.css"),
                "Missing desktop viewer stylesheet").toExternalForm());
        scene.getAccelerators().put(new KeyCodeCombination(KeyCode.O, KeyCombination.SHORTCUT_DOWN), this::chooseFile);
        scene.addEventFilter(KeyEvent.KEY_PRESSED, event -> {
            if (choosingFile || securityDialog == null || !securityDialog.isShowing()) return;
            if (event.getCode() == KeyCode.ESCAPE) {
                event.consume();
                securityDialog.close();
            } else if (event.getCode() == KeyCode.TAB) {
                event.consume();
                securityDialog.traverseFocus(event.isShiftDown());
            } else if (event.isShortcutDown() && event.getCode() == KeyCode.C && securityDialog.copySelection()) {
                event.consume();
            } else if (event.isShortcutDown() && event.getCode() == KeyCode.A && securityDialog.selectReportText()) {
                event.consume();
            } else if (event.isShortcutDown() && event.getCode() == KeyCode.O) {
                event.consume();
            }
        });
        scene.setOnDragOver(event -> {
            if (metadataBackdrop.isVisible()) { event.consume(); return; }
            if (event.getDragboard().hasFiles()) event.acceptTransferModes(TransferMode.COPY);
            event.consume();
        });
        scene.setOnDragDropped(event -> {
            if (metadataBackdrop.isVisible()) { event.consume(); return; }
            var files = event.getDragboard().getFiles();
            boolean opened = files.size() == 1 && files.getFirst().isFile();
            if (opened) open(files.getFirst().toPath());
            else status.setText("Choose one DICOM file or DICOM PDF archive.");
            event.setDropCompleted(opened);
            event.consume();
        });
        scene.addEventFilter(InputEvent.ANY, event -> {
            if (choosingFile) event.consume();
        });
        window.addEventFilter(WindowEvent.WINDOW_CLOSE_REQUEST, event -> {
            if (choosingFile) event.consume();
        });
        window.titleProperty().bind(name.textProperty());
        window.getIcons().add(icon);
        window.setMinWidth(740);
        window.setMinHeight(500);
        window.setScene(scene);
        window.setMaximized(true);
        window.show();
        if (file != null) open(file);
    }

    private void buildData() {
        data.getStyleClass().add("sidebar");
        data.setMinWidth(160);
        data.setPrefWidth(300);
        study.setMaxWidth(Double.MAX_VALUE);
        study.setPromptText("Select exam");
        series.setMaxWidth(Double.MAX_VALUE);
        series.setFixedCellSize(98);
        series.setPlaceholder(detailText("No matching series."));
        series.getStyleClass().add("series-list");
        series.setCellFactory(view -> new ListCell<>() {
            @Override protected void updateItem(Series value, boolean empty) {
                super.updateItem(value, empty);
                setGraphic(empty || value == null ? null : seriesCard(value));
            }
        });
        var examLabel = new Label("Exam");
        var seriesSummary = new StackPane();
        seriesSearch.setPromptText("Find a series");
        seriesSearch.textProperty().addListener((property, before, value) -> {
            String term = value.strip().toLowerCase(java.util.Locale.ROOT);
            visibleSeries.setPredicate(item -> (item.modality() + " " + item.description() + " " + item.number()).toLowerCase(java.util.Locale.ROOT).contains(term));
        });
        var examPicker = new VBox(5, examLabel, study);
        examPicker.visibleProperty().bind(javafx.beans.binding.Bindings.size(study.getItems()).greaterThan(1));
        examPicker.managedProperty().bind(examPicker.visibleProperty());
        series.prefHeightProperty().bind(javafx.beans.binding.Bindings.min(245,
                javafx.beans.binding.Bindings.max(60, javafx.beans.binding.Bindings.size(visibleSeries).multiply(98).add(3))));
        managed(seriesSummary, false);
        managed(series, false);
        managed(seriesSearch, false);
        list.setPlaceholder(new Label("No images loaded"));
        list.setCellFactory(view -> new ListCell<>() {
            @Override protected void updateItem(Manifest.Image image, boolean empty) {
                super.updateItem(image, empty);
                setText(empty || image == null ? null : (getIndex() + 1) + "   " + basename(image));
            }
        });
        study.valueProperty().addListener((value, before, current) -> {
            var stacks = current == null ? List.<Series>of() : current.series();
            seriesSearch.clear();
            studySeries.setAll(stacks);
            studySummary.setText(current == null ? "" : current.description() + "\n" + current.facility());
            managed(studySummary, current != null);
            if (current != null) studySummary.setTooltip(new Tooltip("Body area: " + current.area() + "\nFacility: " + current.facility()));
            managed(seriesSummary, stacks.size() == 1);
            seriesSummary.getChildren().clear();
            if (stacks.size() == 1) seriesSummary.getChildren().add(styled(seriesCard(stacks.getFirst()), "series-single"));
            managed(series, stacks.size() > 1);
            managed(seriesSearch, stacks.size() >= 5);
            series.getSelectionModel().selectFirst();
        });
        series.getSelectionModel().selectedItemProperty().addListener((value, before, current) -> {
            if (current == null) return;
            list.getItems().setAll(current.entries());
            list.getSelectionModel().selectFirst();
        });
        list.getSelectionModel().selectedItemProperty().addListener((value, before, current) -> {
            if (current != null && !updatingControls) select(current);
        });
        var hide = button("‹", () -> togglePane(data, restoreData, false));
        hide.setAccessibleText("Hide data pane");
        managed(studySummary, false);
        data.getChildren().setAll(heading(count, hide), examPicker, studySummary, seriesSearch, seriesSummary, series,
                new Label("Images and reports"), list);
        VBox.setVgrow(list, Priority.ALWAYS);
    }

    private Node seriesCard(Series value) {
        var preview = new ImageView();
        preview.setFitWidth(60);
        preview.setFitHeight(60);
        preview.setPreserveRatio(true);
        var box = styled(new StackPane(preview), "series-thumbnail");
        box.setMinSize(65, 65);
        box.setPrefSize(65, 65);
        var type = styled(new Label(value.modality()), "file-title");
        var description = detailText(value.description());
        description.setMaxHeight(43);
        var subtitle = detailText(value.summary());
        var card = row("series-card", box, new VBox(1, type, description, subtitle));
        var thumb = seriesThumbnails.get(value);
        if (thumb == null && seriesThumbnails.size() < 48) {
            thumb = new javafx.beans.property.SimpleObjectProperty<>();
            seriesThumbnails.put(value, thumb);
            var property = thumb;
            var current = document;
            var representative = value.entries().stream().filter(entry -> "rendered".equals(entry.status())).findFirst();
            if (current != null && current.isArchive() && representative.isPresent()) {
                run(() -> current.thumbnail(representative.get().referencePage()), result -> {
                    if (result != null && current == document) property.set(SwingFXUtils.toFXImage(result, null));
                });
            }
        }
        if (thumb != null) preview.imageProperty().bind(thumb);
        Tooltip.install(card, new Tooltip(value.description() + "\n" + value.summary()));
        return card;
    }

    private void buildDetails() {
        details.getStyleClass().add("metadata-pane");
        details.setMinWidth(230);
        details.setPrefWidth(360);
        managed(supportingFiles, false);
        managed(referenceDetails, false);
        inventory.setWrapText(true);
        var hide = button("›", () -> togglePane(details, restoreDetails, false));
        hide.setAccessibleText("Hide metadata pane");
        metadataButton.setOnAction(event -> metadata());
        metadataButton.setDisable(true);
        metadataButton.setMaxWidth(Double.MAX_VALUE);
        metadataButton.setGraphic(new Label("↗"));
        metadataButton.setContentDisplay(ContentDisplay.RIGHT);
        metadataButton.getStyleClass().add("metadata-open");
        var disclosures = List.of(supportingFiles, disclosure("Inventory", new VBox(8, inventory, referenceDetails)));
        archiveDetails.getChildren().setAll(disclosures);
        var sections = new VBox(metadataButton, archiveDetails);
        var scroll = styled(new ScrollPane(sections), "metadata-scroll");
        scroll.setFitToWidth(true);
        scroll.setHbarPolicy(ScrollPane.ScrollBarPolicy.NEVER);
        disclosures.forEach(section -> keepSectionHeaderVisible(section, scroll));
        VBox.setVgrow(scroll, Priority.ALWAYS);
        details.getChildren().setAll(heading(new Label("Metadata"), hide), scroll);
    }

    private void buildReader() {
        configurePaneRestore(restoreData, data, "show-data-pane", "Show data pane", Pos.TOP_LEFT);
        configurePaneRestore(restoreDetails, details, "show-metadata-pane", "Show metadata pane", Pos.TOP_RIGHT);
        center.getChildren().setAll(modes, restoreData, restoreDetails);
        modes.setTabClosingPolicy(TabPane.TabClosingPolicy.UNAVAILABLE);
        sourceNameTab.setDisable(true);
        sourceNameTab.setGraphic(sourceName);
        sourceNameTab.getStyleClass().add("source-name-tab");
        var leftRestoreInset = Bindings.when(restoreData.visibleProperty()).then(42).otherwise(0);
        var rightRestoreInset = Bindings.when(restoreDetails.visibleProperty()).then(42).otherwise(0);
        sourceName.maxWidthProperty().bind(Bindings.max(0, center.widthProperty().subtract(320)
                .subtract(leftRestoreInset).subtract(rightRestoreInset)));
        sourceName.setMinWidth(0);
        modes.getTabs().setAll(imageTab, sourceNameTab);

        info.setSelected(true);
        info.setOnAction(event -> viewport.overlay(info.isSelected()));
        brightness.setPrefWidth(95);
        contrast.setPrefWidth(95);
        position.setPrefWidth(85);
        frameNumber.setEditable(true);
        frameNumber.setPrefWidth(77);
        fps.setEditable(true);
        fps.setPrefWidth(85);
        var controls = new FlowPane(7, 7,
                row("inline", new Label("Frame"), frameNumber, play, new Label("fps"), fps),
                row("inline", new Label("Window"), windows),
                row("inline", new Label("Brightness"), brightness),
                row("inline", new Label("Contrast"), contrast),
                button("Previous", () -> step(-1)), position, button("Next", () -> step(1)),
                button("−", () -> viewport.zoom(1 / 1.15)), button("+", () -> viewport.zoom(1.15)),
                button("↶ 90°", () -> viewport.rotate(-90)), button("↷ 90°", () -> viewport.rotate(90)),
                invert, button("Fit", viewport::center), info, button("Fullscreen", () -> stage.setFullScreen(!stage.isFullScreen())),
                button("Pin for comparison", this::pin), button("Reset", this::reset));
        controls.getStyleClass().add("controls");
        controls.disableProperty().bind(documentLoaded.not());
        VBox primary = new VBox(imageArea, controls);
        VBox.setVgrow(imageArea, Priority.ALWAYS);
        HBox.setHgrow(primary, Priority.ALWAYS);
        primary.setMinWidth(0);
        images.getChildren().setAll(primary);
        imageTab.setContent(images);
        viewport.setOnScroll(event -> {
            if (event.isControlDown() || event.isMetaDown()) viewport.zoom(event.getDeltaY() > 0 ? 1.12 : 1 / 1.12);
            else if (event.getDeltaY() != 0) step(event.getDeltaY() < 0 ? 1 : -1);
            event.consume();
        });
        frameNumber.valueProperty().addListener((value, before, now) -> {
            if (!updatingControls && now != null && now != frame) selectFrame(now);
        });
        position.valueProperty().addListener((value, before, now) -> {
            if (updatingControls) return;
            int index = (int) Math.round(now.doubleValue());
            if (frames > 1) selectFrame(index);
            else list.getSelectionModel().select(index - 1);
        });
        windows.setOnAction(event -> { if (!updatingControls) showEntry(); });
        brightness.valueProperty().addListener(ignored -> adjust());
        contrast.valueProperty().addListener(ignored -> adjust());
        invert.setOnAction(event -> adjust());
        play.setOnAction(event -> updateCine());
        fps.valueProperty().addListener(ignored -> updateCine());
        modes.getSelectionModel().selectedItemProperty().addListener((value, before, now) -> {
            if (now == pdfTab) showPage();
            if (now != imageTab) stopCine();
        });
        stage.focusedProperty().addListener((value, before, focused) -> { if (!focused) stopCine(); });

        pageNumber.setEditable(true);
        pageNumber.setPrefWidth(92);
        pageNumber.valueProperty().addListener(ignored -> { if (!updatingControls) showPage(); });
        reference.setPreserveRatio(true);
        var pdfPage = new StackPane(reference);
        var scroll = new ScrollPane(pdfPage);
        scroll.setFitToWidth(true);
        reference.fitWidthProperty().bind(scroll.widthProperty().subtract(28));
        VBox pdf = new VBox(row("reader-heading",
                button("‹", () -> pageNumber.decrement()), new Label("Page"), pageNumber, pageCount,
                button("›", () -> pageNumber.increment()), new Label("Summary, inventory and presentation references")), scroll);
        VBox.setVgrow(scroll, Priority.ALWAYS);
        pdfTab.setContent(pdf);
    }

    private void chooseFile() {
        var chosen = choosePath("Open File", null);
        if (chosen != null) open(chosen);
    }

    private Path choosePath(String title, String suggestedName) {
        return nativePicker(parent -> DesktopViewerPortal.choose(parent, title, suggestedName, OPEN_FILTER, OPEN_PATTERNS), () -> {
            var chooser = new FileChooser();
            chooser.setTitle(title);
            File chosen;
            if (suggestedName == null) {
                chooser.getExtensionFilters().setAll(new FileChooser.ExtensionFilter(OPEN_FILTER, OPEN_PATTERNS),
                        new FileChooser.ExtensionFilter("All files", "*"));
                chosen = chooser.showOpenDialog(pickerOwner());
            } else {
                chooser.setInitialFileName(suggestedName);
                chosen = chooser.showSaveDialog(pickerOwner());
            }
            return chosen == null ? null : chosen.toPath();
        }, null);
    }

    @FunctionalInterface
    private interface PortalPicker<T> {
        T choose(String parent) throws java.io.IOException;
    }

    private <T> T nativePicker(PortalPicker<T> portal, java.util.function.Supplier<T> fallback, T cancelled) {
        if (choosingFile) return cancelled;
        choosingFile = true;
        try {
            if (LINUX) {
                var dialogOwner = javafx.stage.Window.getWindows().stream().filter(javafx.stage.Window::isFocused)
                        .findFirst().orElse(stage);
                var peer = com.sun.javafx.stage.WindowHelper.getPeer(dialogOwner);
                long handle = peer == null ? 0 : peer.getRawHandle();
                String parent = handle == 0 ? "" : "x11:" + Long.toHexString(handle);
                var picker = new Task<T>() {
                    @Override protected T call() throws java.io.IOException { return portal.choose(parent); }
                };
                picker.setOnSucceeded(event -> Platform.exitNestedEventLoop(picker, null));
                picker.setOnFailed(event -> Platform.exitNestedEventLoop(picker, null));
                Thread.ofVirtual().start(picker);
                Platform.enterNestedEventLoop(picker);
                if (picker.getException() == null) return picker.getValue();
            }
            return fallback.get();
        } finally {
            choosingFile = false;
        }
    }

    private Stage pickerOwner() {
        // GTK can apply the normal bounds of a maximized owner when it disables the window.
        return LINUX && (stage.isMaximized() || stage.isFullScreen()) ? null : stage;
    }

    private void open(Path path) {
        long request = openRequest.incrementAndGet();
        opening = true;
        stopCine();
        status.setText("Loading " + path.getFileName() + "…");
        reader.execute(() -> {
            if (request != openRequest.get()) return;
            try {
                var opened = DesktopViewerDocument.open(path);
                if (request != openRequest.get()) { close(opened); return; }
                Platform.runLater(() -> {
                    if (request != openRequest.get()) {
                        if (!reader.isShutdown()) reader.execute(() -> close(opened));
                        else close(opened);
                        return;
                    }
                    opening = false;
                    var previous = document;
                    document = opened;
                    if (previous != null) reader.execute(() -> close(previous));
                    install(opened);
                });
            } catch (Exception error) {
                Platform.runLater(() -> {
                    if (request != openRequest.get()) return;
                    opening = false;
                    failure(error);
                });
            }
        });
    }

    private void install(DesktopViewerDocument opened) {
        if (exportDialog != null) exportDialog.close();
        if (securityDialog != null) securityDialog.close();
        if (archiveSecurity != null) archiveSecurity.cancel();
        archiveSecurity = null;
        if (opened.isArchive()) {
            archiveSecurity = new DesktopViewerSecurityReport.Session(opened, securityTrust, state -> {
                if (document == opened) updateArchiveReportStatus(state);
            });
        }
        displayRequest.incrementAndGet();
        pageRequest.incrementAndGet();
        archiveMode.set(opened.isArchive());
        documentLoaded.set(true);
        modes.getSelectionModel().select(imageTab);
        modes.getTabs().setAll(opened.isArchive() ? List.of(imageTab, pdfTab, sourceNameTab) : List.of(imageTab, sourceNameTab));
        modes.getSelectionModel().select(imageTab);
        specialTab.setContent(null);
        metadataBackdrop.setVisible(false);
        metadataBackdrop.getChildren().clear();
        root.setMouseTransparent(false);
        reference.setImage(null);
        if (images.getChildren().size() > 1) images.getChildren().remove(1);
        imageArea.getChildren().setAll(viewport);
        seriesThumbnails.clear();
        study.getSelectionModel().clearSelection();
        study.setValue(null);
        list.getItems().clear();
        entry = null;
        displayPending = false;
        updateArchiveReportStatus("");
        updateFilename(null);
        metadataButton.setDisable(true);
        shownImage = null;
        viewport.message("Opening file…", opened.path.getFileName().toString());
        var imageEntries = opened.isArchive() ? opened.entries.stream().filter(DesktopViewer::isDicomEntry).toList() : opened.entries;
        count.setText("Data  " + imageEntries.size());
        if (opened.isArchive()) installArchiveDetails(opened);
        else {
            supporting.getChildren().clear();
            managed(supportingFiles, false);
            managed(referenceDetails, false);
            inventory.setText("");
        }
        var studies = groups(imageEntries, "StudyInstanceUID").values().stream()
                .map(exam -> new Study(DesktopViewerOverlay.date(field(exam.getFirst(), "StudyDate", "")),
                        field(exam.getFirst(), "StudyDescription", "Description not provided"),
                        field(exam.getFirst(), "BodyPartExamined", "Body area not provided"),
                        field(exam.getFirst(), "InstitutionName", "Facility not provided"),
                        groups(exam, "SeriesInstanceUID").values().stream().map(stack -> {
                            var first = stack.getFirst();
                            return new Series(modalityLabel(field(first, "Modality", "")),
                                    field(first, "SeriesDescription", "Description not provided"),
                                    field(first, "SeriesNumber", ""), stack);
                        }).toList())).toList();
        study.getItems().setAll(studies);
        study.getSelectionModel().selectFirst();
        if (studies.isEmpty() && !opened.entries.isEmpty()) select(opened.entries.getFirst());
    }

    private void installArchiveDetails(DesktopViewerDocument opened) {
        profile.setText(opened.profile());
        var otherFiles = opened.entries.stream().filter(image -> !isDicomEntry(image)).toList();
        supportingCount.setText(Integer.toString(otherFiles.size()));
        supporting.getChildren().setAll(otherFiles.stream().map(source -> fileRow(basename(source),
                String.format("%,d bytes · %s", source.size(), source.sourcePath()),
                () -> previewSupporting(source), () -> saveOriginal(source))).toList());
        managed(supportingFiles, !otherFiles.isEmpty());
        var links = opened.references();
        managed(referenceDetails, !links.isEmpty());
        var referenceCounts = new TreeMap<String, Integer>();
        links.forEach(link -> referenceCounts.merge(referenceStatus(link), 1, Integer::sum));
        long displayed = opened.entries.stream().filter(image -> "rendered".equals(image.status())).count();
        var summary = new StringBuilder(opened.entries.size() + " supplied files\n" + opened.embeddedOriginalCount() + " embedded originals\n"
                + displayed + " PDF previews\n\n" + otherFiles.size() + " other supplied files\n"
                + links.size() + " explicit references");
        referenceCounts.forEach((state, total) -> summary.append('\n').append(total).append(' ').append(state));
        inventory.setText(summary.toString());
        pageNumber.setValueFactory(new SpinnerValueFactory.IntegerSpinnerValueFactory(1, opened.pages(), 1));
        pageCount.setText("of " + opened.pages());
    }

    private static String modalityLabel(String code) {
        return switch (code) {
            case "CT" -> "CT scan";
            case "MR" -> "MRI scan";
            case "US" -> "Ultrasound";
            case "CR", "DX", "RG" -> "X-ray";
            case "XA" -> "Angiography";
            case "SR" -> "Structured report";
            case "" -> "Image type not provided";
            default -> code + " series";
        };
    }

    private static boolean isDicomEntry(Manifest.Image image) {
        var name = image.sourcePath().toLowerCase(java.util.Locale.ROOT);
        return "rendered".equals(image.status()) || !field(image, "SOPClassUID", "").isBlank()
                || name.endsWith(".dcm") || name.endsWith(".dicom") || name.endsWith("/dicomdir") || name.equals("dicomdir");
    }

    private static Map<String, List<Manifest.Image>> groups(List<Manifest.Image> images, String key) {
        var groups = new LinkedHashMap<String, List<Manifest.Image>>();
        for (var image : images) groups.computeIfAbsent(field(image, key, ""), ignored -> new java.util.ArrayList<>()).add(image);
        return groups;
    }

    private void select(Manifest.Image source) {
        select(source, 1);
    }

    private void select(Manifest.Image source, int initialFrame) {
        if (opening) return;
        entry = source;
        interactiveDisplay = "Not checked";
        metadataButton.setDisable(false);
        modes.getTabs().remove(specialTab);
        specialTab.setContent(null);
        frame = frames = initialFrame;
        resetOnDisplay = true;
        stopCine();
        updatingControls = true;
        frameNumber.setValueFactory(new SpinnerValueFactory.IntegerSpinnerValueFactory(1, frames, frame));
        windows.getItems().setAll(DesktopViewerDocument.INITIAL);
        windows.getSelectionModel().selectFirst();
        updatingControls = false;
        int referencePage = source.referencePage();
        boolean hasReference = referencePage >= 1 && referencePage <= document.pages();
        if (!hasReference || modes.getSelectionModel().getSelectedItem() != pdfTab) {
            modes.getSelectionModel().select(imageTab);
        }
        if (hasReference) pageNumber.getValueFactory().setValue(referencePage);
        showEntry();
    }

    private void updateFilename(String sourcePath) {
        String name = document.path.getFileName().toString();
        if (document.isArchive()) {
            filename.setText(name);
            updateArchiveFilenameDescription();
        } else {
            localFilename.setText(name);
            localFilename.setTooltip(new Tooltip(name));
        }
        sourceName.setText(sourcePath == null ? "" : sourcePath.substring(sourcePath.lastIndexOf('/') + 1));
        sourceName.setTooltip(sourcePath == null ? null : new Tooltip(sourcePath));
    }

    private void updateArchiveReportStatus(String state) {
        archiveReportStatus = state;
        filename.pseudoClassStateChanged(javafx.css.PseudoClass.getPseudoClass("integrity-pass"), state.equals("PASS"));
        filename.pseudoClassStateChanged(javafx.css.PseudoClass.getPseudoClass("integrity-fail"), state.equals("FAIL"));
        filename.pseudoClassStateChanged(javafx.css.PseudoClass.getPseudoClass("integrity-unknown"), state.equals("UNKNOWN"));
        filename.pseudoClassStateChanged(javafx.css.PseudoClass.getPseudoClass("integrity-checking"), state.equals("CHECKING"));
        updateArchiveFilenameDescription();
    }

    private void updateArchiveFilenameDescription() {
        String description = switch (archiveReportStatus) {
            case "PASS" -> "Integrity checks passed";
            case "FAIL" -> "Security checks failed";
            case "UNKNOWN" -> "Security checks incomplete";
            case "CHECKING" -> "Checking archive security";
            default -> "";
        };
        String name = filename.getText();
        if (!description.isEmpty()) name += " · " + description;
        filename.setTooltip(new Tooltip(name + "\nOpen archive security report"));
        filename.setAccessibleText(name + " — Open archive security report");
    }

    private void previewSupporting(Manifest.Image source) {
        var current = document;
        run(() -> current.previewSupporting(source), preview -> {
            if (document == current) showAttachment(basename(source), preview);
        });
    }

    private void showAttachment(String name, DesktopViewerDocument.Display preview) {
        if (preview.image() == null) dialog(name, preview.text());
        else {
            var image = new ImageView(SwingFXUtils.toFXImage(preview.image(), null));
            image.setPreserveRatio(true);
            var scroll = new ScrollPane(new StackPane(image));
            scroll.setFitToWidth(true);
            image.fitWidthProperty().bind(javafx.beans.binding.Bindings.max(0, scroll.widthProperty().subtract(28)));
            showDetailsDialog(name, scroll);
        }
        status.setText("Viewing " + name);
    }

    private void selectFrame(int target) {
        if (target == frame || target < 1 || target > frames) return;
        frame = target;
        showEntry();
    }

    private void showEntry() {
        var current = document;
        var source = entry;
        if (current == null || source == null) return;
        long request = displayRequest.incrementAndGet();
        displayPending = true;
        int wantedFrame = frame;
        var window = windows.getValue() == null ? DesktopViewerDocument.INITIAL : windows.getValue();
        updatingControls = true;
        frameNumber.getValueFactory().setValue(frame);
        position.setMax(Math.max(2, frames > 1 ? frames : list.getItems().size()));
        position.setValue(frames > 1 ? frame : Math.max(1, list.getSelectionModel().getSelectedIndex() + 1));
        updatingControls = false;
        if (shownImage == null) status.setText("Opening " + basename(source) + "…");
        reader.execute(() -> {
            if (request != displayRequest.get()) return;
            try {
                var display = current.load(source, wantedFrame, window);
                Platform.runLater(() -> {
                    if (request == displayRequest.get()) display(source, display, wantedFrame, window);
                });
            } catch (Exception error) {
                Platform.runLater(() -> {
                    if (request != displayRequest.get()) return;
                    displayPending = false;
                    stopCine();
                    shownImage = null;
                    imageArea.getChildren().setAll(viewport);
                    updateFilename(source.sourcePath());
                    interactiveDisplay = "Could not open; see status";
                    viewport.message("Original preview unavailable", error.getMessage());
                    failure(error);
                    if (archiveSecurity != null) archiveSecurity.start();
                });
            }
        });
    }

    private void display(Manifest.Image source, DesktopViewerDocument.Display display, int wantedFrame,
                         DesktopViewerDocument.Window window) {
        displayPending = false;
        imageArea.getChildren().setAll(viewport);
        updateFilename(source.sourcePath());
        if (resetOnDisplay) {
            brightness.setValue(0);
            contrast.setValue(100);
            invert.setSelected(false);
            viewport.reset();
            resetOnDisplay = false;
        }
        frames = display.frames();
        updatingControls = true;
        frameNumber.setValueFactory(new SpinnerValueFactory.IntegerSpinnerValueFactory(1, frames, wantedFrame));
        position.setMax(Math.max(2, frames > 1 ? frames : list.getItems().size()));
        position.setValue(frames > 1 ? wantedFrame : Math.max(1, list.getSelectionModel().getSelectedIndex() + 1));
        windows.getItems().setAll(display.windows());
        windows.setValue(display.windows().contains(window) ? window : DesktopViewerDocument.INITIAL);
        updatingControls = false;
        interactiveDisplay = display.image() != null || !display.surfaces().isEmpty() || display.spectrum() != null
                ? "Opened successfully" : "Not supported; original available";
        if (display.image() != null) {
            shownImage = SwingFXUtils.toFXImage(display.image(), null);
            if (archiveSecurity == null) {
                var thumbnail = seriesThumbnails.get(series.getSelectionModel().getSelectedItem());
                if (thumbnail != null && thumbnail.get() == null) thumbnail.set(shownImage);
            }
            var exam = study.getValue();
            if (exam != null && display.overlay() != null && !display.overlay().facility().isBlank()) {
                studySummary.setText(exam.description() + "\n" + display.overlay().facility());
                studySummary.setTooltip(new Tooltip("Body area: " + exam.area() + "\nFacility: " + display.overlay().facility()));
            }
            shownRatio = display.rowRatio();
            var information = DesktopViewerOverlay.context(source, display.overlay(), list.getItems().indexOf(source) + 1,
                    list.getItems().size(), wantedFrame, frames, display.text());
            viewport.show(shownImage, shownRatio, information);
        } else if (!display.surfaces().isEmpty()) {
            shownImage = null;
            showSpecial("3D surface", new DesktopViewerSurface(display.surfaces()));
            viewport.message("DICOM Surface Segmentation", "See the 3D surface tab.");
        } else if (display.spectrum() != null) {
            shownImage = null;
            showSpecial("MR spectroscopy", spectroscopy(display.spectrum()));
            viewport.message("MR spectroscopy", "See the MR spectroscopy tab.");
        } else {
            shownImage = null;
            viewport.message("No image available", archiveSecurity == null ? "Use Selected file metadata to inspect this object."
                    : "Use Selected file metadata or PDF reference to inspect this object.");
            if (archiveSecurity != null && !isDicomEntry(source)) dialog(basename(source), display.text());
            else {
                var contents = new TextArea(display.text());
                contents.setEditable(false);
                contents.setWrapText(true);
                imageArea.getChildren().setAll(contents);
            }
        }
        String frameStatus = "Frame " + wantedFrame + " of " + frames;
        status.setText(archiveSecurity == null ? frameStatus : frameStatus + " · Original SHA-256 verified");
        if (archiveSecurity != null) archiveSecurity.start();
    }

    private void showSpecial(String title, Node node) {
        specialTab.setText(title);
        specialTab.setContent(node);
        if (!modes.getTabs().contains(specialTab)) modes.getTabs().add(modes.getTabs().indexOf(sourceNameTab), specialTab);
        if (modes.getSelectionModel().getSelectedItem() != pdfTab) {
            modes.getSelectionModel().select(specialTab);
        }
    }

    private static Node spectroscopy(DesktopViewerSpecial.Spectrum spectrum) {
        var frame = new Spinner<Integer>(1, spectrum.frames(), 1);
        var row = new Spinner<Integer>(1, spectrum.rows(), 1);
        var column = new Spinner<Integer>(1, spectrum.columns(), 1);
        var fourier = new CheckBox("Fourier spectrum");
        fourier.setDisable(!spectrum.domain().equals("TIME") || spectrum.components() != 2);
        var x = new javafx.scene.chart.NumberAxis();
        var y = new javafx.scene.chart.NumberAxis();
        var chart = new javafx.scene.chart.LineChart<Number, Number>(x, y);
        chart.setAnimated(false);
        chart.setCreateSymbols(false);
        var controls = row("controls", new Label("Frame"), frame, new Label("Row"), row,
                new Label("Column"), column, fourier);
        for (var spinner : List.of(frame, row, column)) spinner.setPrefWidth(80);
        Runnable draw = () -> {
            var trace = spectrum.trace(frame.getValue(), row.getValue(), column.getValue(), fourier.isSelected());
            x.setLabel(trace.axis());
            y.setLabel("Signal");
            boolean frequency = fourier.isSelected() || spectrum.domain().equals("FREQUENCY");
            double step = frequency ? -spectrum.width() / trace.real().length : 1000 / spectrum.width();
            int centerBin = trace.real().length / 2;
            double first = frequency ? (centerBin - (fourier.isSelected() ? 1 : 0)) * -step : 0;
            chart.getData().setAll(traceSeries(fourier.isSelected() ? "Magnitude" : "Signal", trace.real(), first, step));
            if (trace.imaginary() != null) chart.getData().add(traceSeries("Imaginary", trace.imaginary(), first, step));
        };
        frame.valueProperty().addListener(ignored -> draw.run());
        row.valueProperty().addListener(ignored -> draw.run());
        column.valueProperty().addListener(ignored -> draw.run());
        fourier.selectedProperty().addListener(ignored -> draw.run());
        draw.run();
        VBox.setVgrow(chart, Priority.ALWAYS);
        return new VBox(controls, chart);
    }

    private static javafx.scene.chart.XYChart.Series<Number, Number> traceSeries(String name, double[] values,
                                                                              double first, double step) {
        var series = new javafx.scene.chart.XYChart.Series<Number, Number>();
        series.setName(name);
        for (int i = 0; i < values.length; i += Math.max(1, values.length / 2500))
            series.getData().add(new javafx.scene.chart.XYChart.Data<>(first + i * step, values[i]));
        return series;
    }

    private void showPage() {
        var current = document;
        if (current == null || !current.isArchive() || modes.getSelectionModel().getSelectedItem() != pdfTab) return;
        long request = pageRequest.incrementAndGet();
        int page = pageNumber.getValue();
        run(() -> request == pageRequest.get() ? current.page(page) : null, image -> {
            if (image != null && request == pageRequest.get() && document == current) {
                reference.setImage(SwingFXUtils.toFXImage(image, null));
                archiveSecurity.start();
            }
        });
    }

    private void adjust() { viewport.adjust(brightness.getValue(), contrast.getValue(), invert.isSelected()); }

    private void step(int delta) {
        int next = frame + delta;
        if (frames > 1 && next >= 1 && next <= frames) selectFrame(next);
        else list.getSelectionModel().select(list.getSelectionModel().getSelectedIndex() + delta);
    }

    private void reset() {
        brightness.setValue(0);
        contrast.setValue(100);
        invert.setSelected(false);
        viewport.reset();
        windows.getSelectionModel().selectFirst();
    }

    private void updateCine() {
        cine.stop();
        if (!play.isSelected() || frames < 2) { stopCine(); return; }
        play.setText("Pause");
        cine.getKeyFrames().setAll(new KeyFrame(Duration.seconds(1 / fps.getValue()), event -> {
            // Let the submitted frame reach the viewport before requesting the next one.
            if (!displayPending) selectFrame(frame >= frames ? 1 : frame + 1);
        }));
        cine.setCycleCount(Timeline.INDEFINITE);
        cine.play();
    }

    private void stopCine() {
        cine.stop();
        play.setSelected(false);
        play.setText("Play");
    }

    private void pin() {
        if (displayPending || shownImage == null) return;
        var pinned = new DesktopViewerCanvas(stage.getIcons().getFirst());
        pinned.show(shownImage, shownRatio, entry.sourcePath() + " · Frame " + frame);
        pinned.setOnScroll(event -> pinned.zoom(event.getDeltaY() > 0 ? 1.12 : 1 / 1.12));
        var section = new VBox(row("reader-heading", new Label("Pinned original"),
                button("Close", () -> images.getChildren().remove(1))), pinned,
                row("controls", button("−", () -> pinned.zoom(1 / 1.15)), button("+", () -> pinned.zoom(1.15)),
                        button("↶ 90°", () -> pinned.rotate(-90)), button("↷ 90°", () -> pinned.rotate(90)),
                        button("Fit", pinned::center), button("Reset", pinned::reset)));
        section.setMinWidth(0);
        VBox.setVgrow(pinned, Priority.ALWAYS);
        HBox.setHgrow(section, Priority.ALWAYS);
        if (images.getChildren().size() > 1) images.getChildren().set(1, section);
        else images.getChildren().add(section);
    }

    private void metadata() {
        if (entry == null || metadataBackdrop.isVisible()) return;
        var source = entry;
        var current = document;
        run(() -> current.selectedMetadata(source), values -> {
            if (document == current && entry == source && !metadataBackdrop.isVisible()) {
                values.put("Interactive display", interactiveDisplay);
                showSelectedMetadata(source, values);
            }
        });
    }

    private void showSelectedMetadata(Manifest.Image source, Map<String, Object> values) {
        var title = styled(new Label("Selected file metadata"), "selected-metadata-title");
        HBox.setHgrow(title, Priority.ALWAYS);
        title.setMaxWidth(Double.MAX_VALUE);
        Runnable dismiss = () -> {
            metadataBackdrop.setVisible(false);
            metadataBackdrop.getChildren().clear();
            root.setMouseTransparent(false);
            metadataButton.requestFocus();
        };
        var close = styled(button("×", dismiss), "selected-metadata-close");
        close.setAccessibleText("Close selected file metadata");
        var header = row("selected-metadata-header", title, close);

        var fields = styled(new VBox(12), "selected-metadata-fields");
        var referenceActions = selectedReferenceActions(source, dismiss);
        if (!referenceActions.isEmpty()) {
            var section = new VBox(4, styled(new Label("REFERENCES"), "selected-metadata-term"));
            section.getChildren().addAll(referenceActions);
            fields.getChildren().add(section);
        }
        values.forEach((key, value) -> {
            var term = styled(new Label(key.toUpperCase(java.util.Locale.ROOT)), "selected-metadata-term");
            term.setWrapText(true);
            var description = styled(new Label(java.util.Objects.toString(value, "Not supplied")), "selected-metadata-value");
            description.setWrapText(true);
            description.setMaxWidth(Double.MAX_VALUE);
            var copy = item("Copy value", () -> {
                var clipboard = new javafx.scene.input.ClipboardContent();
                clipboard.putString(description.getText());
                javafx.scene.input.Clipboard.getSystemClipboard().setContent(clipboard);
            });
            description.setContextMenu(new ContextMenu(copy));
            fields.getChildren().add(new VBox(4, term, description));
        });

        var scrolling = styled(new ScrollPane(fields), "selected-metadata-scroll");
        scrolling.setFitToWidth(true);
        scrolling.setHbarPolicy(ScrollPane.ScrollBarPolicy.NEVER);
        scrolling.setFocusTraversable(true);
        VBox.setVgrow(scrolling, Priority.ALWAYS);
        var card = styled(new VBox(header, scrolling), "selected-metadata-dialog");
        card.setMinSize(0, 0);
        card.maxWidthProperty().bind(javafx.beans.binding.Bindings.min(820, metadataBackdrop.widthProperty().subtract(32)));
        card.maxHeightProperty().bind(metadataBackdrop.heightProperty().multiply(.85));
        card.setPrefSize(820, 740);
        metadataBackdrop.getChildren().setAll(card);
        var focusOrder = new ArrayList<Node>(List.of(close, scrolling));
        focusOrder.addAll(referenceActions);
        metadataBackdrop.setOnKeyPressed(event -> {
            switch (event.getCode()) {
                case ESCAPE -> close.fire();
                case TAB -> {
                    int focused = Math.max(0, focusOrder.indexOf(stage.getScene().getFocusOwner()));
                    int next = Math.floorMod(focused + (event.isShiftDown() ? -1 : 1), focusOrder.size());
                    focusOrder.get(next).requestFocus();
                }
                default -> {
                    if (!event.isShortcutDown()) return;
                }
            }
            event.consume();
        });
        metadataBackdrop.setVisible(true);
        root.setMouseTransparent(true);
        close.requestFocus();
    }

    private void verify() {
        if (archiveSecurity == null) return;
        if (securityDialog != null && securityDialog.isShowing()) return;
        securityDialog = new DesktopViewerSecurityReport(stage, filename, archiveSecurity, securityTrust,
                this::destination, this::chooseCertificates, status::setText);
        securityDialog.show();
    }

    private List<Path> chooseCertificates() {
        String title = "Add trusted CA certificates";
        String filterName = "Certificate files";
        var patterns = List.of("*.pem", "*.crt", "*.cer", "*.der");
        return nativePicker(parent -> DesktopViewerPortal.chooseMultiple(parent, title, filterName, patterns), () -> {
            var chooser = new FileChooser();
            chooser.setTitle(title);
            chooser.getExtensionFilters().add(new FileChooser.ExtensionFilter(filterName, patterns));
            var selected = chooser.showOpenMultipleDialog(pickerOwner());
            return selected == null ? List.of() : selected.stream().map(File::toPath).toList();
        }, List.of());
    }

    private void saveOriginal() {
        saveOriginal(entry);
    }

    private void saveOriginal(Manifest.Image source) {
        if (source == null) return;
        var archive = document;
        var path = destination("Save original", basename(source));
        if (path != null) run(() -> { archive.saveOriginal(source, path); return path; }, this::saved);
    }

    private void saveZip(ZipScope scope) {
        if (document == null || !document.isArchive()) return;
        var archive = document;
        List<Manifest.Image> selected = switch (scope) {
            case SELECTED -> entry == null ? List.of() : List.of(entry);
            case SERIES -> List.copyOf(list.getItems());
            case EXAM -> study.getValue() == null ? List.of()
                    : study.getValue().series().stream().flatMap(stack -> stack.entries().stream()).toList();
            case ALL -> archive.entries;
        };
        if (selected.isEmpty()) return;
        var path = destination("Save originals ZIP", "dicom-originals.zip");
        if (path != null) run(() -> { archive.saveZip(selected, scope == ZipScope.ALL, path); return path; }, this::saved);
    }

    private void saveImage() {
        if (displayPending || shownImage == null) return;
        var path = destination("Save image copy", "dicom-view-copy.png");
        if (path == null) return;
        var pixels = SwingFXUtils.fromFXImage(viewport.copy(), null);
        run(() -> { DesktopViewerDocument.write(path, out -> ImageIO.write(pixels, "PNG", out)); return path; }, this::saved);
    }

    private void exportMetadata() {
        if (document == null || !document.isArchive()) return;
        if (exportDialog != null && exportDialog.isShowing()) return;
        exportDialog = new DesktopViewerExport(stage, document, entry, reader, this::destination, status::setText);
        exportDialog.show();
    }

    private Path destination(String title, String name) {
        Path path = choosePath(title, name);
        if (path == null) return null;
        try {
            if (document != null && java.nio.file.Files.exists(path) && java.nio.file.Files.isSameFile(path, document.path))
                throw new java.io.IOException("Choose a different destination from the open file.");
        } catch (java.io.IOException error) {
            failure(error);
            return null;
        }
        return path;
    }

    private void saved(Path path) { status.setText("Saved " + path.getFileName()); }

    private void dialog(String title, String text) {
        var contents = new TextArea(text);
        contents.setEditable(false);
        contents.setWrapText(true);
        showDetailsDialog(title, contents);
    }

    private void showDetailsDialog(String title, Node contents) {
        var alert = new Alert(Alert.AlertType.NONE, "", ButtonType.CLOSE);
        alert.initOwner(stage);
        alert.initModality(javafx.stage.Modality.NONE);
        alert.setTitle(title);
        alert.setHeaderText(title);
        alert.getDialogPane().getStylesheets().setAll(stage.getScene().getStylesheets());
        alert.getDialogPane().setContent(contents);
        alert.setResizable(true);
        alert.setWidth(Math.min(800, stage.getWidth()));
        alert.setHeight(Math.min(540, stage.getHeight()));
        alert.show();
    }

    private <T> void run(Callable<T> job, Consumer<T> complete) {
        reader.execute(() -> {
            try {
                T result = job.call();
                Platform.runLater(() -> complete.accept(result));
            } catch (Exception error) {
                Platform.runLater(() -> failure(error));
            }
        });
    }

    private void failure(Exception error) {
        status.setText(error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
    }

    private void configurePaneRestore(Button restore, VBox pane, String id, String label, Pos alignment) {
        restore.setId(id);
        restore.getStyleClass().add("pane-restore");
        restore.setAccessibleText(label);
        restore.setTooltip(new Tooltip(label));
        restore.setMaxSize(Region.USE_PREF_SIZE, Region.USE_PREF_SIZE);
        StackPane.setAlignment(restore, alignment);
        StackPane.setMargin(restore, new Insets(4, 8, 0, 8));
        var showing = PseudoClass.getPseudoClass(id);
        restore.visibleProperty().addListener((value, before, visible) -> modes.pseudoClassStateChanged(showing, visible));
        managed(restore, false);
        restore.setOnAction(event -> togglePane(pane, restore, true));
    }

    private void togglePane(VBox pane, Button restore, boolean show) {
        if (workspace.getItems().contains(data) && data.getWidth() > 0) dataWidth = data.getWidth();
        if (workspace.getItems().contains(details) && details.getWidth() > 0) detailsWidth = details.getWidth();
        if (show) workspace.getItems().add(pane == data ? 0 : workspace.getItems().size(), pane);
        else workspace.getItems().remove(pane);
        managed(restore, !show);
        double width = workspace.getWidth();
        if (width <= 0) return;
        boolean left = workspace.getItems().contains(data), right = workspace.getItems().contains(details);
        double leftPosition = (dataWidth + 4) / width;
        double rightPosition = 1 - (detailsWidth + 4) / width;
        if (left && right) workspace.setDividerPositions(leftPosition, rightPosition);
        else if (left || right) workspace.setDividerPositions(left ? leftPosition : rightPosition);
    }

    private static void managed(Node node, boolean visible) { node.setVisible(visible); node.setManaged(visible); }

    private static HBox heading(Label title, Button hide) {
        HBox.setHgrow(title, Priority.ALWAYS);
        title.setMaxWidth(Double.MAX_VALUE);
        return row("panel-heading", title, hide);
    }

    private static TitledPane disclosure(String title, Node contents) {
        var pane = styled(new TitledPane(title, contents), "metadata-section");
        pane.setExpanded(false);
        pane.setAnimated(false);
        return pane;
    }

    private static TitledPane fileDisclosure(String title, VBox files, Label badge) {
        var pane = disclosure(title, files);
        pane.setGraphic(badge);
        pane.setContentDisplay(ContentDisplay.RIGHT);
        return pane;
    }

    private static void keepSectionHeaderVisible(TitledPane section, ScrollPane scroll) {
        section.skinProperty().addListener((property, before, skin) -> {
            // Use the TitledPane skin's title so mouse, keyboard and accessibility behavior stay native.
            var header = section.lookup(".title");
            if (header == null) return;
            header.translateYProperty().bind(Bindings.createDoubleBinding(() -> {
                if (!section.isExpanded()) return 0.0;
                double viewportTop = scroll.getLocalToSceneTransform().getTy() + scroll.snappedTopInset();
                double sectionTop = section.getLocalToSceneTransform().getTy();
                double headerTop = header.getLayoutY();
                double limit = section.getHeight() - headerTop - header.getLayoutBounds().getHeight();
                return Math.max(0, Math.min(viewportTop - sectionTop - headerTop, limit));
            }, section.expandedProperty(), section.heightProperty(), section.localToSceneTransformProperty(),
                    scroll.localToSceneTransformProperty(), scroll.insetsProperty(), header.layoutYProperty(),
                    header.layoutBoundsProperty()));
        });
    }

    private List<Button> selectedReferenceActions(Manifest.Image source, Runnable dismiss) {
        var links = document.references().stream()
                .filter(link -> Objects.equals(source.attachment(), link.sourceAttachment()))
                .filter(link -> "resolved".equals(link.status()) && link.resolvedAttachments() != null
                        && link.resolvedAttachments().size() == 1)
                .toList();
        if (links.isEmpty()) return List.of();

        var files = filesByAttachment(document);
        var actions = new LinkedHashMap<String, Button>();
        for (var link : links) {
            String attachment = link.resolvedAttachments().getFirst();
            var target = files.get(attachment);
            if (target == null || !isDicomEntry(target) || actions.containsKey(attachment)) continue;
            int referencedFrame = link.frames() == null || link.frames().isEmpty()
                    ? 1 : Objects.requireNonNullElse(link.frames().getFirst(), 1);
            int firstFrame = Math.max(1, Math.min(referencedFrame, number(target, "NumberOfFrames", 1)));
            String label = "Open " + basename(target) + (firstFrame > 1 ? " · Frame " + firstFrame : "");
            var open = styled(button(label, () -> {
                dismiss.run();
                openReferencedFile(target, firstFrame);
            }), "reference-link");
            open.setTooltip(new Tooltip(target.sourcePath()));
            open.setWrapText(true);
            open.setMaxWidth(Double.MAX_VALUE);
            actions.put(attachment, open);
        }
        return List.copyOf(actions.values());
    }

    private void openReferencedFile(Manifest.Image target, int firstFrame) {
        for (var exam : study.getItems()) {
            for (var stack : exam.series()) {
                if (!stack.entries().contains(target)) continue;
                updatingControls = true;
                try {
                    study.getSelectionModel().select(exam);
                    if (!visibleSeries.contains(stack)) seriesSearch.clear();
                    series.getSelectionModel().select(stack);
                    list.getSelectionModel().select(target);
                    series.scrollTo(stack);
                    list.scrollTo(target);
                } finally {
                    updatingControls = false;
                }
                modes.getSelectionModel().select(imageTab);
                select(target, firstFrame);
                return;
            }
        }
    }

    private void showReferenceDetails() {
        if (document == null || !document.isArchive()) return;
        var files = filesByAttachment(document);
        var report = new StringJoiner("\n\n");
        for (var link : document.references()) {
            var source = files.get(link.sourceAttachment());
            String path = source == null ? Objects.toString(link.sourceAttachment(), "Source file unavailable") : source.sourcePath();
            var detail = new StringBuilder(path).append('\n').append(referenceStatus(link)).append(" · ")
                    .append(Objects.toString(link.sopInstanceUID(), "No target instance ID recorded"));
            if (link.resolvedAttachments() != null) {
                for (String attachment : link.resolvedAttachments()) {
                    var target = files.get(attachment);
                    if (target != null) detail.append("\n  → ").append(target.sourcePath());
                }
            }
            report.add(detail.toString());
        }
        dialog("Reference details", report.toString());
    }

    private static String referenceStatus(Manifest.Reference link) {
        return Objects.toString(link.status(), "unassessed").replace('-', ' ');
    }

    private static Map<String, Manifest.Image> filesByAttachment(DesktopViewerDocument archive) {
        var files = new LinkedHashMap<String, Manifest.Image>();
        archive.entries.forEach(source -> files.putIfAbsent(source.attachment(), source));
        return files;
    }

    private static Label detailText(String text) {
        var label = styled(new Label(text), "file-facts");
        label.setWrapText(true);
        return label;
    }

    private static Node fileRow(String name, String facts, Runnable preview, Runnable download) {
        var title = styled(new Label(name), "file-title");
        title.setWrapText(true);
        var text = new VBox(3, title, detailText(facts));
        text.setMinWidth(0);
        HBox.setHgrow(text, Priority.ALWAYS);
        var actions = new VBox(5, fileAction(name, true, preview), fileAction(name, false, download));
        actions.setAlignment(Pos.CENTER);
        return row("file-card", text, actions);
    }

    private static Button fileAction(String name, boolean view, Runnable action) {
        var button = styled(button("", action), view ? "file-view" : "file-download");
        String label = (view ? "View " : "Download ") + name;
        button.setAccessibleText(label);
        button.setTooltip(new Tooltip(label));
        button.setGraphic(fileActionIcon(view));
        return button;
    }

    // Exact extension icon geometry from viewer/file-icons.mjs, with its 24-unit view box.
    private static Node fileActionIcon(boolean view) {
        var paths = view ? List.of("M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z", "M9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0")
                : List.of("M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5");
        var glyph = new javafx.scene.Group();
        for (String path : paths) {
            var part = styled(new javafx.scene.shape.SVGPath(), "file-action-path");
            part.setContent(path);
            glyph.getChildren().add(part);
        }
        double size = view ? 18 : 17;
        glyph.getTransforms().add(new javafx.scene.transform.Scale(size / 24, size / 24));
        glyph.setManaged(false);
        var icon = new Pane(glyph);
        icon.setMinSize(size, size);
        icon.setPrefSize(size, size);
        icon.setMaxSize(size, size);
        icon.setMouseTransparent(true);
        return icon;
    }

    private static <T extends Node> T styled(T node, String style) { node.getStyleClass().add(style); return node; }

    private static HBox row(String style, Node... nodes) {
        var row = styled(new HBox(8, nodes), style);
        row.setAlignment(Pos.CENTER_LEFT);
        return row;
    }

    private static Button button(String text, Runnable action) {
        var button = new Button(text);
        button.setOnAction(event -> action.run());
        return button;
    }

    private static MenuItem item(String text, Runnable action) {
        var item = new MenuItem(text);
        item.setOnAction(event -> action.run());
        return item;
    }

    private static String basename(Manifest.Image entry) {
        return entry.sourcePath().substring(entry.sourcePath().lastIndexOf('/') + 1);
    }

    private static void close(DesktopViewerDocument archive) {
        try { archive.close(); } catch (java.io.IOException ignored) {}
    }

    @Override public void stop() {
        stopCine();
        if (archiveSecurity != null) archiveSecurity.cancel();
        openRequest.incrementAndGet();
        displayRequest.incrementAndGet();
        pageRequest.incrementAndGet();
        if (document != null) reader.execute(() -> close(document));
        reader.shutdown();
    }
}
