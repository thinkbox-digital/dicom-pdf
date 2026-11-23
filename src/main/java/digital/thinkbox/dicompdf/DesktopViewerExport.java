package digital.thinkbox.dicompdf;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.Executor;
import java.util.function.BiFunction;
import java.util.function.Consumer;
import javafx.collections.FXCollections;
import javafx.collections.transformation.FilteredList;
import javafx.concurrent.Task;
import javafx.geometry.Insets;
import javafx.scene.control.*;
import javafx.scene.layout.HBox;
import javafx.scene.layout.VBox;
import javafx.stage.Modality;
import javafx.stage.Stage;

final class DesktopViewerExport extends Dialog<ButtonType> {
    private final DesktopViewerDocument document;
    private final Manifest.Image selected;
    private final Executor worker;
    private final Label progress = new Label();
    private final ComboBox<String> scope = choices("Selected image", "All images");
    private final ComboBox<String> fieldsMode = choices("All fields", "Selected fields");
    private final ComboBox<String> layout = choices("One row per file (spreadsheet)", "Detailed tag rows");
    private final TextField search = new TextField();
    private final javafx.collections.ObservableList<DicomMetadataInventory.Element> fields = FXCollections.observableArrayList();
    private final FilteredList<DicomMetadataInventory.Element> matching = new FilteredList<>(fields);
    private final ListView<DicomMetadataInventory.Element> fieldList = new ListView<>(matching);
    private final Set<String> selection = new HashSet<>();
    private final Button confirm;
    private List<DicomMetadataInventory.Image> records = List.of();
    private Task<List<DicomMetadataInventory.Image>> loading;

    DesktopViewerExport(Stage owner, DesktopViewerDocument document, Manifest.Image selected, Executor worker,
                        BiFunction<String, String, Path> destination, Consumer<String> status) {
        this.document = document;
        this.selected = selected;
        this.worker = worker;
        initOwner(owner);
        initModality(Modality.NONE);
        setTitle("Export metadata");
        setResizable(true);
        var pane = getDialogPane();
        pane.getStylesheets().setAll(owner.getScene().getStylesheets());
        pane.setPrefWidth(780);
        var csv = new ButtonType("Export CSV", ButtonBar.ButtonData.OK_DONE);
        var xmp = new ButtonType("Save document XMP", ButtonBar.ButtonData.OTHER);
        pane.getButtonTypes().setAll(csv, xmp, ButtonType.CLOSE);
        confirm = (Button) pane.lookupButton(csv);
        confirm.getStyleClass().add("primary");
        pane.lookupButton(xmp).setDisable(!document.hasXmp());
        pane.lookupButton(csv).addEventFilter(javafx.event.ActionEvent.ACTION, event -> {
            event.consume();
            Set<String> paths = fieldsMode.getSelectionModel().getSelectedIndex() == 0 ? null : Set.copyOf(selection);
            if (paths != null && paths.isEmpty()) { progress.setText("Select one or more metadata fields."); return; }
            boolean detailed = layout.getSelectionModel().getSelectedIndex() == 1;
            String name = detailed ? "dicom-metadata-details.csv" : "dicom-metadata.csv";
            var path = destination.apply("Export DICOM metadata", name);
            if (path != null) {
                var rows = List.copyOf(records);
                save(() -> { DesktopViewerMetadata.export(path, rows, paths, detailed); return null; }, "Exported " + name, status);
            }
        });
        pane.lookupButton(xmp).addEventFilter(javafx.event.ActionEvent.ACTION, event -> {
            event.consume();
            var path = destination.apply("Save document XMP", "document-metadata.xmp");
            if (path != null) save(() -> { document.saveXmp(path); return null; }, "Saved document XMP", status);
        });
        var intro = new Label("Choose images and fields for a CSV file, or save the document XMP. Pixel data is omitted.");
        intro.setWrapText(true);
        progress.setWrapText(true);
        search.setPromptText("Find a field or tag path");
        search.textProperty().addListener((property, before, query) -> {
            String term = query.strip().toLowerCase(Locale.ROOT);
            matching.setPredicate(field -> display(field).toLowerCase(Locale.ROOT).contains(term));
        });
        fieldList.setPrefHeight(290);
        fieldList.setCellFactory(view -> new ListCell<>() {
            private final CheckBox choice = new CheckBox();
            {
                choice.setWrapText(true);
                choice.setOnAction(event -> {
                    var field = getItem();
                    if (field != null) {
                        if (choice.isSelected()) selection.add(field.path());
                        else selection.remove(field.path());
                    }
                });
            }
            @Override protected void updateItem(DicomMetadataInventory.Element field, boolean empty) {
                super.updateItem(field, empty);
                setGraphic(empty || field == null ? null : choice);
                if (empty || field == null) return;
                choice.setText(display(field));
                choice.setSelected(selection.contains(field.path()));
            }
        });
        var all = new Button("Select all");
        all.setOnAction(event -> { fields.forEach(field -> selection.add(field.path())); fieldList.refresh(); });
        var clear = new Button("Clear selection");
        clear.setOnAction(event -> { selection.clear(); fieldList.refresh(); });
        var selecting = fieldsMode.getSelectionModel().selectedIndexProperty().isEqualTo(1);
        fieldList.disableProperty().bind(selecting.not());
        all.disableProperty().bind(selecting.not().or(javafx.beans.binding.Bindings.isEmpty(fields)));
        clear.disableProperty().bind(all.disableProperty());
        var content = new VBox(10, intro, new HBox(12, labeled("Scope", scope), labeled("Fields", fieldsMode)),
                labeled("CSV layout", layout), search, new HBox(8, all, clear),
                labeled("Metadata fields", fieldList), progress);
        content.setPadding(new Insets(12));
        pane.setContent(content);
        if (selected == null) scope.getSelectionModel().select(1);
        scope.setDisable(selected == null);
        scope.setOnAction(event -> load());
        setOnShown(event -> load());
        setOnHidden(event -> { if (loading != null) loading.cancel(); });
    }

    private void load() {
        if (loading != null) loading.cancel();
        confirm.setDisable(true);
        fields.clear();
        records = List.of();
        var sources = scope.getSelectionModel().getSelectedIndex() == 0 && selected != null ? List.of(selected) : document.entries;
        var task = new Task<List<DicomMetadataInventory.Image>>() {
            @Override protected List<DicomMetadataInventory.Image> call() throws Exception {
                var rows = new ArrayList<DicomMetadataInventory.Image>();
                for (var source : sources) {
                    if (isCancelled()) break;
                    updateMessage("Reading metadata: " + (rows.size() + 1) + " of " + sources.size() + " files…");
                    rows.add(DesktopViewerMetadata.record(document, source));
                }
                return List.copyOf(rows);
            }
        };
        loading = task;
        progress.setText("Reading source metadata…");
        task.messageProperty().addListener((observable, before, value) -> { if (loading == task && isShowing()) progress.setText(value); });
        task.setOnSucceeded(event -> {
            if (loading != task || !isShowing()) return;
            records = task.getValue();
            var catalog = DesktopViewerMetadata.fields(records);
            selection.retainAll(catalog.keySet());
            fields.setAll(catalog.values().stream().sorted(Comparator.comparing(DicomMetadataInventory.Element::path)).toList());
            long incomplete = records.stream().filter(record -> !"readable".equals(record.status())).count();
            progress.setText(records.size() + " source files · " + fields.size() + " fields"
                    + (incomplete == 0 ? "" : " · " + incomplete + " files have metadata diagnostics"));
            confirm.setDisable(records.isEmpty());
        });
        task.setOnFailed(event -> { if (loading == task && isShowing()) progress.setText(task.getException().getMessage()); });
        worker.execute(task);
    }

    private void save(java.util.concurrent.Callable<Void> output, String message, Consumer<String> status) {
        var task = new Task<Void>() {
            @Override protected Void call() throws Exception { return output.call(); }
        };
        task.setOnSucceeded(event -> { status.accept(message); close(); });
        task.setOnFailed(event -> progress.setText(task.getException().getMessage()));
        worker.execute(task);
    }

    private static ComboBox<String> choices(String... items) {
        var combo = new ComboBox<String>(FXCollections.observableArrayList(items));
        combo.getSelectionModel().selectFirst();
        return combo;
    }

    private static VBox labeled(String caption, Control control) {
        var label = new Label(caption);
        label.setLabelFor(control);
        return new VBox(4, label, control);
    }

    private static String display(DicomMetadataInventory.Element field) {
        return java.util.Objects.toString(field.keyword(), "") + " · " + field.path()
                + (field.vr() == null || field.vr().isBlank() ? "" : " · " + field.vr());
    }
}
