package digital.thinkbox.dicompdf;

import com.google.gson.JsonParser;
import digital.thinkbox.dicompdf.ArchiveC2pa;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.function.Consumer;
import java.util.concurrent.*;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.cos.*;
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;

/** Independent PDF/A-4f pilot: originals are inventoried before any PDF transformation. */
public final class DicomPdf {
    static final String STAGED_INPUTS_PROPERTY="dicompdf.desktopStagedInputs";
    private DicomPdf() {}
    private record Source(String relative,String attachment,SourceContent content,Attachments.Encoded encoded,long size,String sha256,DicomInput.Result dicom,Path preview,String previewSha256,List<ReferenceInventory.Link> links) {}
    private record Capture(Path directory,List<Source> sources) implements AutoCloseable {
        @Override public void close()throws IOException{try(var paths=Files.walk(directory)){for(var path:paths.sorted(Comparator.reverseOrder()).toList())Files.deleteIfExists(path);}}
    }
    

    public static Manifest create(Path input, Path output) throws Exception { return create(input, output, "archival-master"); }
    public static Manifest create(Path input, Path output, String sourceRole) throws Exception {
        return create(input, output, sourceRole, true);
    }
    public static Manifest create(Path input,Path output,String sourceRole,boolean c2pa)throws Exception{
        return create(input,output,sourceRole,PackageLimits.ATTACHMENTS,PackageLimits.DOCUMENT,bytes->{},null,c2pa,true);
    }
    /** Internal callers may impose smaller limits, never exceed recovery/viewer bounds. */
    static Manifest create(Path input, Path output, String sourceRole, long attachmentLimit, long documentLimit) throws Exception {
        return create(input,output,sourceRole,attachmentLimit,documentLimit,bytes->{});
    }
    @FunctionalInterface interface InputPolicy {void check(SourceContent bytes)throws Exception;}
    static Manifest create(Path input,Path output,String sourceRole,long attachmentLimit,long documentLimit,InputPolicy policy)throws Exception{
        return create(input,output,sourceRole,attachmentLimit,documentLimit,policy,null);
    }
    static Manifest create(Path input,Path output,String sourceRole,byte[] importReceipt)throws Exception{
        return create(input,output,sourceRole,PackageLimits.ATTACHMENTS,PackageLimits.DOCUMENT,bytes->{},importReceipt);
    }
    static Manifest create(Path input,Path output,String sourceRole,long attachmentLimit,long documentLimit,InputPolicy policy,byte[] importReceipt)throws Exception{
        return create(input,output,sourceRole,attachmentLimit,documentLimit,policy,importReceipt,false,true);
    }
    static Manifest create(Path input,Path output,String sourceRole,long attachmentLimit,long documentLimit,InputPolicy policy,byte[] importReceipt,boolean c2pa,boolean finalizeC2pa)throws Exception{
        return create(input,output,sourceRole,attachmentLimit,documentLimit,policy,importReceipt,c2pa,finalizeC2pa,message->{});
    }
    static Manifest create(Path input,Path output,String sourceRole,long attachmentLimit,long documentLimit,InputPolicy policy,byte[] importReceipt,boolean c2pa,boolean finalizeC2pa,Consumer<String> progress)throws Exception{
        if (attachmentLimit < 1 || documentLimit < 1)
            throw new IllegalArgumentException("Publication limits must be positive");
        if (!Set.of("archival-master", "deidentified-copy").contains(sourceRole)) throw new IllegalArgumentException("Source role must be archival-master or deidentified-copy");
        String profileVersion=c2pa?ArchiveC2pa.PROFILE:"0.3.0";
        Path root = input.toRealPath();
        if (!Files.isDirectory(root)) throw new IllegalArgumentException("Input must be a directory");
        Path destination = output.toAbsolutePath().normalize();
        Files.createDirectories(destination.getParent());
        destination = destination.getParent().toRealPath().resolve(destination.getFileName());
        if (destination.startsWith(root)) throw new IllegalArgumentException("Output must be outside the input directory");
        try(var capture=capture(root,progress)){
        List<Source> sources=capture.sources();
        byte[] receipt=importReceipt==null?null:ImportProvenance.validate(importReceipt);
        if(receipt!=null){
            var observed=JsonParser.parseString(new String(receipt,StandardCharsets.UTF_8)).getAsJsonObject();
            if(observed.get("memberCount").getAsInt()!=sources.size()||sources.stream().anyMatch(source->!source.relative.startsWith("contents/")))throw new IOException("ZIP import receipt does not match captured members.");
        }
        for(Source source:sources)policy.check(source.content);
        Path staged = Files.createTempFile(destination.getParent(), ".dicom-pdf-", ".pdf");
        try {
            Manifest manifest;
            try (var doc = new PDDocument(org.apache.pdfbox.io.IOUtils.createTempFileOnlyStreamCache())) {
                PDType0Font font;
                try (var in = resource("/fonts/DejaVuSans.ttf")) { font = PDType0Font.load(doc, in, true); }
                var attachments = new Attachments(doc);
                Map<String,SourceContent> originalBytes = new LinkedHashMap<>();
                for (Source source : sources) originalBytes.put(source.attachment, source.content);
                progress.accept("Checking DICOM references and duplicate objects…");
                var relations=ReferenceInventory.resolveEntries(sources.stream().map(source->
                        new ReferenceInventory.Entry(source.attachment,source.dicom.fields(),source.links)).toList());
                var references=relations.references();
                var duplicates=relations.duplicates();
                summary(doc, font, sources, sourceRole,receipt,profileVersion);
                // Inventory pages precede previews; reserve them using the same pagination used to draw them.
                int summaryPages = doc.getNumberOfPages();
                List<String> placeholder = inventoryLines(sources, references, duplicates, sourceRole, summaryPages, 0,profileVersion);
                int inventoryPages = inventoryWrapped(font, placeholder).size();
                inventoryPages = (inventoryPages + 44) / 45;
                List<String> inventory = inventoryLines(sources, references, duplicates, sourceRole, summaryPages, inventoryPages,profileVersion);
                List<String> inventoryWrapped = inventoryWrapped(font, inventory);
                int stablePages = (inventoryWrapped.size() + 44) / 45;
                if (stablePages != inventoryPages) {
                    inventoryPages = stablePages;
                    inventory = inventoryLines(sources, references, duplicates, sourceRole, summaryPages, inventoryPages,profileVersion);
                    inventoryWrapped = inventoryWrapped(font, inventory);
                    if ((inventoryWrapped.size() + 44) / 45 != inventoryPages) throw new IOException("Inventory pagination did not stabilize");
                }
                pages(doc, font, inventoryWrapped);
                List<Manifest.Image> images = new ArrayList<>();
                for (Source source : sources) {
                    progress.accept("Writing reference page and embedding original "+(images.size()+1)+"/"+sources.size()+": "+displayPath(source.relative));
                    var dicom = source.dicom;
                    Path preview=source.preview;
                    String status = preview == null ? "unrendered" : "rendered";
                    var image = new Manifest.Image(source.attachment, source.relative, dicom.fields().get("SOPInstanceUID"), source.sha256,
                            source.size, doc.getNumberOfPages() + 1, status, dicom.reason(), dicom.fields(),
                            true, true, preview == null, preview == null ? null : 1,
                            dicom.displayAdjustments(), preview == null ? null : source.previewSha256);
                    images.add(image);
                    var file = attachments.add(source.attachment, source.encoded, source.size, "application/dicom", "Source", "Original supplied file: " + source.relative);
                    PDPage page = reference(doc, font, image, preview);
                    if(preview!=null)Files.delete(preview);
                    COSArray pageFiles = new COSArray(); pageFiles.add(file);
                    page.getCOSObject().setItem(COSName.getPDFName("AF"), pageFiles);
                }
                Map<String,SourceContent> artifacts = new LinkedHashMap<>();
                progress.accept("Building the full metadata inventory…");
                if(receipt!=null){
                    artifacts.put("import-source.json",SourceContent.of(receipt));
                    artifacts.put("import-source.schema.json",resourceContent("/import-source.schema.json"));
                }
                artifacts.put("inventory.txt",SourceContent.of((String.join("\n",inventory)+"\n").getBytes(StandardCharsets.UTF_8)));
                Path sidecar=capture.directory.resolve("dicom-metadata.json");
                long sidecarBudget=attachmentLimit;
                for(var source:sources){
                    if(source.size>sidecarBudget)throw new IOException("Originals exceed the configured recovery limit");
                    sidecarBudget-=source.size;
                }
                var metadataHash=MessageDigest.getInstance("SHA-256");
                try(var outputStream=new java.security.DigestOutputStream(Files.newOutputStream(sidecar),metadataHash)){
                    DicomMetadataInventory.writeCaptured(images,originalBytes,true,DicomMetadataInventory.bounded(outputStream,sidecarBudget));
                }
                var metadata=SourceContent.file(sidecar,new SourceContent.Digest(Files.size(sidecar),HexFormat.of().formatHex(metadataHash.digest())));
                artifacts.put("dicom-metadata.json",metadata);
                artifacts.put("metadata-mapping.json",resourceContent("/metadata-mapping.json"));
                progress.accept("Checking DICOM attributes, payload structure and directories…");
                artifacts.put("dicom-validation.json",SourceContent.of(DicomValidation.bytes(DicomValidation.capture(images,originalBytes))));
                artifacts.put("dicom-structure.json",SourceContent.of(DicomStructure.bytes(DicomStructure.capture(images,originalBytes))));
                artifacts.put("dicom-directory.json",SourceContent.of(DicomDirectory.bytes(DicomDirectory.capture(images,originalBytes))));
                artifacts.put("display-mapping.json",resourceContent("/display-mapping.json"));
                for(String name:List.of("dicom-xmp.rng","profile.json","field-mapping.json","RECOVERY.txt"))
                    artifacts.put(name,resourceContent("/"+name));
                if(c2pa){
                    artifacts.put("RECOVERY.txt",resourceContent("/c2pa-RECOVERY.txt"));
                    artifacts.put(ArchiveC2pa.POLICY,SourceContent.of(ArchiveC2pa.POLICY_BYTES));
                    artifacts.put("profile.json",resourceContent("/c2pa-profile.json"));
                    artifacts.put("dicom-xmp.rng",resourceContent("/c2pa-dicom-xmp.rng"));
                }
                Map<String,String> artifactHashes=new LinkedHashMap<>();
                for(var artifact:artifacts.entrySet())artifactHashes.put(artifact.getKey(),artifact.getValue().digest().sha256());
                manifest = new Manifest(2, "dicom-images", profileVersion, ApplicationVersion.CREATOR, sourceRole,
                        1, List.copyOf(images), references, duplicates, Collections.unmodifiableMap(artifactHashes));
                byte[] manifestBytes = ManifestEncoding.encode(manifest);
                String json = new String(manifestBytes, StandardCharsets.UTF_8);
                // Count every recoverable byte, including generated resources;
                // input limits alone do not guarantee that extraction can succeed.
                long recoverable = 0;
                if(c2pa)recoverable=PackageLimits.reserve(recoverable,ArchiveC2pa.CAPACITY);
                for (Source source : sources) recoverable = PackageLimits.reserve(recoverable, source.size);
                for (var artifact : artifacts.values()) recoverable = PackageLimits.reserve(recoverable, artifact.digest().length());
                recoverable = PackageLimits.reserve(recoverable, manifestBytes.length);
                recoverable = PackageLimits.reserve(recoverable, (sha256(manifestBytes) + "  manifest.json\n").getBytes(StandardCharsets.UTF_8).length);
                if (recoverable > attachmentLimit) throw new IOException("Originals and package resources exceed the configured recovery limit");
                attachments.add("manifest.json", manifestBytes, "application/json", "Data", "Version 2 source/frame/display inventory and SHA-256 hashes");
                attachments.add("manifest.sha256", (sha256(manifestBytes) + "  manifest.json\n").getBytes(StandardCharsets.UTF_8), "text/plain", "Data", "SHA-256 checksum of manifest.json; integrity check, no authentication claim");
                for (var artifact : artifacts.entrySet()) {
                    String name = artifact.getKey();
                    String mime = name.endsWith(".json") ? "application/json" : name.endsWith(".rng") ? "application/xml" : "text/plain";
                    attachments.add(name, artifact.getValue(), mime, name.endsWith(".rng")||name.endsWith(".schema.json") ? "Schema" : "Supplement", "DICOM image profile "+profileVersion+": " + name);
                }
                attachments.finish();
                progress.accept("Writing archive metadata and PDF pages…");
                if(c2pa)ArchiveC2pa.attach(doc);
                PdfMetadata.applyStream(doc,json,metadata);
                doc.getDocumentCatalog().setLanguage("en-US");
                doc.getDocumentCatalog().setPageMode(PageMode.USE_ATTACHMENTS);
                try (var documentOutput = PackageLimits.documentOutput(Files.newOutputStream(staged), documentLimit)) {
                    doc.save(documentOutput);
                }
            }
            if(c2pa&&finalizeC2pa){progress.accept("Completing Content Credentials…");ArchiveC2pa.complete(staged,null,null);}
            if (Files.size(staged) > documentLimit)
                throw new IOException("Generated PDF exceeds the configured viewer limit; output was not published");
            progress.accept("Verifying every embedded original against the captured bytes…");
            verifySavedOriginals(staged, sources);
            try { Files.move(staged, destination, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
            catch (AtomicMoveNotSupportedException e) { Files.move(staged, destination, StandardCopyOption.REPLACE_EXISTING); }
            return manifest;
        } finally { Files.deleteIfExists(staged); }
        }
    }

    private static String displayPath(String path){return path.replaceAll("[\\p{Cntrl}]","?");}
    private static Capture capture(Path root,Consumer<String> progress)throws Exception {
        Path directory=SourceContent.scratchDirectory("source-snapshot-",root);
        var sources=new ArrayList<Source>();var captured=new Capture(directory,sources);
        try{
            // A single file or ZIP has already been copied into the desktop's private run directory.
            String stagedInputs=System.getProperty(STAGED_INPUTS_PROPERTY);
            boolean reuseStage=stagedInputs!=null&&root.equals(Path.of(stagedInputs));
            progress.accept("Scanning selected inputs…");
            var paths=InputFiles.collect(root);
            progress.accept("Found "+paths.size()+" supplied files; capturing originals and preparing reference images…");
            int workers=captureWorkers(paths.size());
            progress.accept("Preparing reference images with "+workers+" worker"+(workers==1?"":"s")+"…");
            try(var executor=Executors.newFixedThreadPool(workers)){
                var completion=new ExecutorCompletionService<Integer>(executor);
                var ordered=new Source[paths.size()];
                int dispatched=0,finished=0;
                try {
                    while(finished<paths.size()){
                        while(dispatched<paths.size() && dispatched-finished<workers){
                            final int index=dispatched++;
                            completion.submit(()->{
                                ordered[index]=captureSource(root,paths.get(index),directory,index,reuseStage);
                                return index;
                            });
                        }
                        int index;
                        try{index=completion.take().get();}
                        catch(ExecutionException failure){if(failure.getCause() instanceof Exception cause)throw cause;throw failure;}
                        Source source=ordered[index];
                        progress.accept("Prepared file "+(++finished)+"/"+paths.size()+": "+displayPath(source.relative)+" — "+(source.preview==null?"original preserved without a reference image":"reference image ready"));
                    }
                    Collections.addAll(sources,ordered);
                }finally{executor.shutdownNow();}
            }
            if(sources.isEmpty())throw new IllegalArgumentException("Input directory contains no files");return captured;
        }catch(Exception failure){captured.close();throw failure;}
    }
    static int captureWorkers(int files){
        Runtime runtime = Runtime.getRuntime();
        long available = runtime.maxMemory() - (runtime.totalMemory() - runtime.freeMemory());
        long workersByHeap = available / (256L * 1024 * 1024);
        int requested = Integer.getInteger("dicompdf.workers", 4);
        int workers = Math.min(files, Math.min(requested, runtime.availableProcessors()));
        return (int) Math.max(1, Math.min(workers, workersByHeap));
    }
    private static Source captureSource(Path root,Path path,Path directory,int index,boolean reuseStage)throws Exception{
        if(!Files.isRegularFile(path,LinkOption.NOFOLLOW_LINKS))throw new IOException("Input is not a regular file");
        long observed=Files.size(path);
        var content=SourceContent.file(path);
        if(!reuseStage){
            content=content.snapshot(directory.resolve("source-"+index+".dcm"),Long.MAX_VALUE);
            if(!content.digest().equals(SourceContent.file(path).digest()))
                throw new IOException("Source changed while its archival snapshot was captured");
        }
        var encoded=Attachments.prepare(content,directory.resolve("original-"+index+".flate"));
        var digest=content.digest();
        if(observed!=digest.length())throw new IOException("Source changed while its archival snapshot was captured");
        String relative=root.relativize(path).toString().replace(File.separatorChar,'/');
        ArchivePath.check(relative);
        String attachment="original-"+String.format(Locale.ROOT,"%04d",index+1)+".dcm";
        var capture=DicomInput.capture(content);
        var inspected=capture.preview();Path preview=null;String previewHash=null;
        if(inspected.image()!=null){
            var rgb=DicomInput.rgb(inspected.image());
            preview=directory.resolve("preview-"+index+".png");previewHash=DicomInput.previewSha256(rgb);
            if(!javax.imageio.ImageIO.write(rgb,"png",preview.toFile()))throw new IOException("Could not spool the reference image");
            inspected.image().flush();
        }
        var metadata=new DicomInput.Result(inspected.fields(),null,inspected.reason(),inspected.displayAdjustments());
        return new Source(relative,attachment,content,encoded,digest.length(),digest.sha256(),metadata,preview,previewHash,capture.links());
    }

    private static void summary(PDDocument doc, PDType0Font font, List<Source> sources, String sourceRole,byte[] importReceipt,String profileVersion) throws Exception {
        long rendered = sources.stream().filter(s -> s.preview != null).count();
        List<String> lines = new ArrayList<>(List.of(
            "DICOM study summary", "Profile dicom-images "+profileVersion+" | PDF/A-4f preservation package",
            "Source role: " + sourceRole + " (caller assertion; no de-identification performed)", "",
            "Originals preserved: " + sources.size() + " | Reference images: " + rendered + " | Unrendered: " + (sources.size() - rendered),
            "Every supplied regular file is attached byte for byte, including unrenderable files.",
            "Reference images are for presentation. No calibrated measurements are provided.",
            "Original files and selected metadata can contain patient information.", "",
            "Viewing and recovery",
            "Read the reference pages in a PDF reader or open this PDF in the DICOM desktop viewer.",
            "manifest.json maps previews to unchanged originals, one-based frames and display recipes.",
            "For recovery, save RECOVERY.txt, manifest.json and the original attachments.",
            "Use inspect/extract/verify commands or an ordinary PDF attachment extraction tool.",
            "Unsupported images have an explanation page and remain available as attachments.", "",
            "Study fields supplied by the originals"));
        if(importReceipt!=null){
            var receipt=JsonParser.parseString(new String(importReceipt,StandardCharsets.UTF_8)).getAsJsonObject();
            lines.add(6,"ZIP import: "+receipt.get("sourceName").getAsString()+"; extracted members preserved; transport container not embedded.");
            lines.add(7,"Container name, byte length and SHA-256 are recorded in import-source.json.");
        }
        Set<String> studies = new LinkedHashSet<>();
        for (Source source : sources) {
            Map<String,String> f = source.dicom.fields();
            if (!f.containsKey("StudyInstanceUID")) continue;
            studies.add("Study UID: " + f.get("StudyInstanceUID") + "\nPatient ID: " + f.getOrDefault("PatientID", "not supplied")
                    + " | Date: " + f.getOrDefault("StudyDate", "not supplied") + "\nDescription: " + f.getOrDefault("StudyDescription", "not supplied"));
        }
        if (studies.isEmpty()) lines.add("No Study Instance UID supplied in readable metadata.");
        for (String study : studies) { lines.addAll(Arrays.asList(study.split("\n"))); lines.add(""); }
        long unknown = sources.stream().filter(s -> !s.dicom.fields().containsKey("StudyInstanceUID")).count();
        if (unknown > 0) lines.add(unknown + " file(s) have no readable Study Instance UID; no study membership inferred.");
        lines.add("Image labels reproduce supplied fields; absent tooth, side and orientation data are not inferred.");
        List<String> wrapped = new ArrayList<>(); for (String line : lines) wrapped.addAll(wrap(font, line, 10, 495));
        pages(doc, font, wrapped);
    }
    private static void pages(PDDocument doc, PDType0Font font, List<String> wrapped) throws Exception {
        for (int offset = 0; offset < wrapped.size(); offset += 45) {
            PDPage page = new PDPage(PDRectangle.A4); doc.addPage(page);
            try (var canvas = new PDPageContentStream(doc, page)) {
                text(canvas, font, 10, 50, 790, wrapped.subList(offset, Math.min(offset + 45, wrapped.size())), 15);
            }
        }
    }
    private static List<String> inventoryWrapped(PDType0Font font, List<String> lines) throws IOException {
        List<String> wrapped = new ArrayList<>(); for (String line : lines) wrapped.addAll(wrap(font, line, 10, 495));
        return wrapped;
    }
    private static List<String> inventoryLines(List<Source> sources, List<Manifest.Reference> references,
            Map<String,List<String>> duplicates, String sourceRole, int summaryPages, int inventoryPages,String profileVersion) {
        long displayed = sources.stream().filter(s -> s.preview != null).count();
        long missing = references.stream().filter(r -> r.status().equals("missing")).count();
        long unresolved = references.stream().filter(r -> !r.status().equals("resolved")).count();
        List<String> lines = new ArrayList<>(List.of("Supplied-file and recovery inventory | profile "+profileVersion, "Source role: " + sourceRole,
                "Supplied: " + sources.size() + " | Embedded unchanged: " + sources.size() + " | Displayed: " + displayed,
                "Rejected for display: " + (sources.size() - displayed) + " | Rejected from preservation: 0",
                "Explicit references: " + references.size() + " | Known missing: " + missing + " | Unresolved: " + unresolved,
                "Counts overlap: display rejection never removes the original attachment.",
                "References reflect explicit SOP reference tags only. Unreadable files may hide unknown references.", ""));
        for (int i = 0; i < sources.size(); i++) {
            Source s = sources.get(i); boolean rendered = s.preview != null;
            lines.add((i+1) + ". " + s.relative);
            lines.add("Supplied YES | Embedded YES | Displayed " + (rendered ? "YES" : "NO") + " | Rejected for display " + (rendered ? "NO" : "YES"));
            lines.add("Attachment: " + s.attachment + " | " + s.size + " bytes | Page " + (summaryPages + inventoryPages + i + 1) + (rendered ? " | Frame 1" : " | No preview frame"));
            lines.add("SOP Instance UID: " + s.dicom.fields().getOrDefault("SOPInstanceUID", "not supplied/readable"));
            lines.add("SHA-256: " + s.sha256);
            if (!rendered) lines.add("Rejection: " + s.dicom.reason());
            lines.add("");
        }
        lines.add("Duplicate SOP Instance UIDs (files are never merged)");
        if (duplicates.isEmpty()) lines.add("None discovered in readable metadata.");
        for (var duplicate : duplicates.entrySet()) lines.add(duplicate.getKey() + " -> " + String.join(", ", duplicate.getValue()));
        lines.add(""); lines.add("Known explicit references");
        if (references.isEmpty()) lines.add("None discovered. This does not prove a complete clinical study.");
        for (var ref : references) {
            lines.add(ref.status().toUpperCase(Locale.ROOT) + " | from " + ref.sourceAttachment() + " | to " + Objects.toString(ref.sopInstanceUID(), "missing UID"));
            lines.add("Path: " + ref.sequencePath() + " | Frames: " + (ref.frames().isEmpty() ? "not specified" : ref.frames()));
            lines.add("Candidates: " + (ref.resolvedAttachments().isEmpty() ? "none supplied" : ref.resolvedAttachments()));
        }
        lines.add(""); lines.add("Recovery: save all attachments or run extract --input file.pdf --output NEW-DIRECTORY.");
        lines.add("Recovered originals are under originals/<sourcePath>; preserve them as masters.");
        lines.add("Create any de-identified derivatives in a separate directory/package; never overwrite masters.");
        lines.add("See RECOVERY.txt, profile.json, field-mapping.json, manifest.json and manifest.sha256.");
        return lines;
    }

    private static PDPage reference(PDDocument doc, PDType0Font font, Manifest.Image image, Path rendered) throws Exception {
        PDPage page = new PDPage(PDRectangle.A4); doc.addPage(page);
        try (var canvas = new PDPageContentStream(doc, page)) {
            var fields = image.fields();
            List<String> labels = new ArrayList<>();
            labels.add("Reference page " + image.referencePage() + " | " + image.status().toUpperCase(Locale.ROOT));
            labels.add("Supplied file: " + image.sourcePath()); labels.add("Attachment: " + image.attachment());
            labels.add("SOP Instance UID: " + Objects.toString(image.sopInstanceUID(), "not supplied"));
            labels.add("Study UID: " + fields.getOrDefault("StudyInstanceUID", "not supplied"));
            for (String key : List.of("PatientID", "StudyDate", "SeriesNumber", "InstanceNumber", "BodyPartExamined", "ViewPosition", "ImageLaterality", "PatientOrientation")) {
                if (fields.containsKey(key)) labels.add(key + ": " + fields.get(key));
            }
            for (var field : fields.entrySet()) if (field.getKey().startsWith("AnatomicRegion[") || field.getKey().startsWith("PrimaryAnatomicStructure[")) labels.add(field.getKey() + ": " + field.getValue());
            labels.add("SHA-256: " + image.sha256());
            if (image.sourceFrame() != null) {
                labels.add("Source frame: " + image.sourceFrame() + " | Window center/width: " + image.displayAdjustments().get("windowCenter") + "/" + image.displayAdjustments().get("windowWidth"));
                labels.add("Display: " + image.displayAdjustments().get("windowMethod") + "; invert=" + image.displayAdjustments().get("invert") + "; no rotation/flips/overlays");
            }
            List<String> wrapped = new ArrayList<>(); for (String line : labels) wrapped.addAll(wrap(font, line, 9, 495));
            // Keep labels readable and the source image bounded even with unusually long metadata.
            if (wrapped.size() > 23) wrapped = new ArrayList<>(wrapped.subList(0, 22));
            wrapped.add("Full selected metadata and source hash: manifest.json");
            text(canvas, font, 9, 50, 793, wrapped, 12);
            float top = 793 - wrapped.size() * 12 - 18;
            if (rendered != null) {
                // The generated RGB PNG already has the exact verified pixels and lossless
                // compression. PDFBox can reuse its compressed stream without another raster conversion.
                var xobject = PDImageXObject.createFromByteArray(doc,Files.readAllBytes(rendered),"reference.png");
                String[] aspect=image.displayAdjustments().getOrDefault("pixelAspectRatio","1:1").split(":");
                float rowRatio=(float)(Double.parseDouble(aspect[0])/Double.parseDouble(aspect[1]));
                float naturalHeight=xobject.getHeight()*rowRatio;
                float scale = Math.min(495f / xobject.getWidth(), (top - 75) / naturalHeight);
                float width = xobject.getWidth() * scale, height = naturalHeight * scale;
                canvas.drawImage(xobject, (page.getMediaBox().getWidth() - width) / 2, top - height, width, height);
            } else {
                var reason = wrap(font, "Image not rendered: " + image.reason(), 11, 495);
                if (reason.size() > 25) reason = reason.subList(0, 25);
                text(canvas, font, 11, 50, top - 20, reason, 16);
            }
            text(canvas, font, 9, 50, 45, List.of("Presentation reference only | Original DICOM attached | No calibrated measurements"), 12);
        }
        return page;
    }

    private static String printable(PDType0Font font, String value) {
        StringBuilder result = new StringBuilder();
        value.codePoints().forEach(cp -> {
            String character = Character.isISOControl(cp) ? " " : new String(Character.toChars(cp));
            try { font.encode(character); result.append(character); }
            catch (Exception e) { result.append('?'); }
        });
        return result.toString();
    }
    static List<String> wrap(PDType0Font font, String value, float size, float width) throws IOException {
        String text = printable(font, value); List<String> lines = new ArrayList<>(); StringBuilder line = new StringBuilder();float lineWidth=0;
        for (int cp : text.codePoints().toArray()) {
            String next = new String(Character.toChars(cp));
            float advance=font.getStringWidth(next);
            if (!line.isEmpty() && (lineWidth+advance) / 1000 * size > width) { lines.add(line.toString()); line.setLength(0);lineWidth=0; }
            line.append(next);lineWidth+=advance;
        }
        lines.add(line.toString()); return lines;
    }
    private static void text(PDPageContentStream canvas, PDType0Font font, float size, float x, float y, List<String> lines, float leading) throws IOException {
        canvas.beginText(); canvas.setFont(font, size); canvas.setNonStrokingColor(0f); canvas.newLineAtOffset(x, y); canvas.setLeading(leading);
        for (String line : lines) { canvas.showText(printable(font, line)); canvas.newLine(); }
        canvas.endText();
    }
    private static InputStream resource(String name) throws IOException {
        InputStream in = DicomPdf.class.getResourceAsStream(name);
        if (in == null) throw new IOException("Required bundled resource missing: " + name);
        return in;
    }
    private static SourceContent resourceContent(String name){return new SourceContent(()->resource(name));}
    private static String sha256(byte[] bytes) throws Exception { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
    private static void verifySavedOriginals(Path saved, List<Source> sources) throws Exception {
        try (var doc = Loader.loadPDF(saved.toFile(),org.apache.pdfbox.io.IOUtils.createTempFileOnlyStreamCache())) {
            var names = doc.getDocumentCatalog().getNames().getEmbeddedFiles().getNames();
            for (Source source : sources) {
                var file = names.get(source.attachment);
                if (file == null) throw new IOException("Saved original is missing: " + source.relative);
                var extracted=PackageTools.content(file).digest();
                if (extracted.length() != source.size || !extracted.sha256().equals(source.sha256)) throw new IOException("Saved original differs from input: " + source.relative);
            }
        }
    }
}
