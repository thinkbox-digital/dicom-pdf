package digital.thinkbox.dicompdf;

import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Small command line; runtime recovery and inspection need no browser. */
public final class Main {
    private Main() {}
    public static void main(String[] args) {
        applyCompressionDefault();
        int exit = run(args, System.out, System.err);
        if (exit != 0) System.exit(exit);
    }

    static void applyCompressionDefault() {
        System.getProperties().putIfAbsent(org.apache.pdfbox.filter.Filter.SYSPROP_DEFLATELEVEL, "1");
    }
    public static int run(String[] args, PrintStream out, PrintStream err) {
        try {
            if (args.length == 0 || args.length == 1 && Set.of("--help", "help").contains(args[0])) { out.print(help()); return 0; }
            String command = args[0];
            Set<String> allowed = switch (command) {
                case "create" -> Set.of("--input", "--output", "--source-role", "--security-config", "--import-provenance", "--c2pa");
                case "inspect" -> Set.of("--input", "--output");
                case "extract" -> Set.of("--input", "--output");
                case "verify" -> Set.of("--input", "--sources", "--verapdf", "--output");
                case "verify-security" -> Set.of("--input", "--sources", "--security-config", "--output");
                case "renew-evidence" -> Set.of("--input", "--previous", "--security-config", "--output");
                case "renew-pdf" -> Set.of("--input", "--security-config", "--output");
                case "verify-evidence" -> Set.of("--input", "--evidence", "--security-config", "--output");
                default -> throw new IllegalArgumentException("Unknown command: " + command);
            };
            Map<String, String> options = new LinkedHashMap<>();
            for (int i = 1; i < args.length; i += 2) {
                if (!allowed.contains(args[i])) throw new IllegalArgumentException("Unknown option for " + command + ": " + args[i]);
                if (i + 1 == args.length || args[i + 1].startsWith("--")) throw new IllegalArgumentException("Missing value for " + args[i]);
                if (options.put(args[i], args[i + 1]) != null) throw new IllegalArgumentException("Duplicate option: " + args[i]);
            }
            Path input = Path.of(require(options, "--input"));
            switch (command) {
                case "create" -> {
                    Manifest manifest;
                    var progress=creationProgress(err);
                    boolean c2pa=c2paOption(options);
                    byte[] importReceipt=options.containsKey("--import-provenance")?ImportProvenance.read(Path.of(options.get("--import-provenance"))):null;
                    if(options.containsKey("--security-config")){
                        var security=new SecurityConfiguration(Path.of(options.get("--security-config")));
                        try(var identity=security.identity(input)){
                            manifest=ArchiveSecurity.create(input,Path.of(require(options,"--output")),options.getOrDefault("--source-role","archival-master"),
                                new ArchiveSecurity.Options(identity,security.policy,security.verapdf,security.protection,java.time.Clock.systemUTC(),security.timestampClient()),importReceipt,c2pa,progress);
                        }
                    }else manifest=DicomPdf.create(input,Path.of(require(options,"--output")),options.getOrDefault("--source-role","archival-master"),PackageLimits.ATTACHMENTS,PackageLimits.DOCUMENT,bytes->{},importReceipt,c2pa,true,progress);
                    long rendered = manifest.images().stream().filter(i -> i.status().equals("rendered")).count();
                    out.printf("Created %s: %d supplied and embedded; %d displayed; %d rejected for display.%n", options.get("--output"), manifest.images().size(), rendered, manifest.images().size() - rendered);
                    for (var image : manifest.images()) if (!image.status().equals("rendered")) err.println("REJECTED FOR DISPLAY " + image.sourcePath() + ": " + image.reason());
                    out.println("Inspect the package for per-file inventory and known missing/ambiguous references.");
                    if(c2pa)out.println("C2PA export credentials embedded. Signer trust requires separate verification; without a certificate, a new local identity is generated for this archive and its private key is discarded.");
                    progress.accept("Archive creation completed.");
                }
                case "inspect" -> { String text = PackageTools.inspect(input); out.print(text); if (options.containsKey("--output")) saveText(input, Path.of(options.get("--output")), text); }
                case "extract" -> {
                    var result = PackageTools.extract(input, Path.of(require(options, "--output")));
                    out.printf("Recovered %d unchanged originals and %d package attachments to %s%n", result.originals(), result.packageFiles(), result.directory());
                    out.println("Original paths are under originals/; package metadata and recovery instructions are under package/.");
                }
                case "verify" -> {
                    Path sources = options.containsKey("--sources") ? Path.of(options.get("--sources")) : null;
                    String validator = options.getOrDefault("--verapdf", SecurityConfiguration.defaultValidator());
                    var result = PackageTools.verify(input, sources, validator);
                    out.print(result.readable());
                    if (options.containsKey("--output")) saveText(input, Path.of(options.get("--output")), result.json(), sources);
                    return result.exitCode();
                }
                case "verify-security" -> {
                    var config=new SecurityConfiguration(Path.of(require(options,"--security-config")));
                    Path sources=options.containsKey("--sources")?Path.of(options.get("--sources")):null;
                    var result=ArchiveSecurity.verify(input,sources,config.policy,config.verapdf,config.protection);
                    out.print(result.json());
                    if(options.containsKey("--output"))saveText(input,Path.of(options.get("--output")),result.json(),sources);
                    return result.exitCode();
                }
                case "renew-pdf" -> {
                    var config=new SecurityConfiguration(Path.of(require(options,"--security-config")));
                    if(config.protection!=ArchiveSecurity.Protection.PADES_B_LTA)throw new IllegalArgumentException("PDF renewal requires PADES_B_LTA protection");
                    try(var identity=digital.thinkbox.dicompdf.ArchiveC2pa.present(input)?config.identityForEvidence():null){
                        var result=ArchivePades.renew(input,Path.of(require(options,"--output")),config.policy,config.verapdf,config.timestampClient(),identity);
                        out.print(result.json());return result.exitCode();
                    }
                }
                case "renew-evidence" -> {
                    var config=new SecurityConfiguration(Path.of(require(options,"--security-config")));
                    Path previous=options.containsKey("--previous")?Path.of(options.get("--previous")):null;
                    try(var identity=config.identityForEvidence()){
                        var result=ArchiveEvidence.renew(input,previous,Path.of(require(options,"--output")),
                            new ArchiveSecurity.Options(identity,config.policy,config.verapdf,config.protection,java.time.Clock.systemUTC(),config.timestampClient()));
                        out.print(result.json());return result.exitCode();
                    }
                }
                case "verify-evidence" -> {
                    var config=new SecurityConfiguration(Path.of(require(options,"--security-config")));
                    Path evidence=Path.of(require(options,"--evidence"));
                    var result=ArchiveEvidence.verify(input,evidence,config.policy);out.print(result.json());
                    if(options.containsKey("--output")){
                        Path output=Path.of(options.get("--output"));
                        if(Files.exists(output)&&Files.isSameFile(evidence,output))throw new IllegalArgumentException("Report must not replace evidence");
                        saveText(input,output,result.json());
                    }
                    return result.exitCode();
                }
                default -> throw new AssertionError(command);
            }
            return 0;
        } catch (Exception e) { err.println("Command failed: " + e.getMessage()); return 1; }
    }
    static java.util.function.Consumer<String> creationProgress(PrintStream stream){return message->{stream.println("Progress: "+message);stream.flush();};}
    static boolean c2paOption(Map<String,String> options){
        String value=options.getOrDefault("--c2pa","on");
        if(!Set.of("on","off").contains(value))throw new IllegalArgumentException("--c2pa must be on or off");
        return value.equals("on");
    }
    private static String require(Map<String,String> options, String key) { String value = options.get(key); if (value == null || value.isBlank()) throw new IllegalArgumentException("Required option: " + key); return value; }
    private static void saveText(Path input, Path output, String text) throws Exception { saveText(input, output, text, null); }
    private static void saveText(Path input, Path output, String text, Path sources) throws Exception {
        if (sources != null) {
            Path root = sources.toRealPath();
            Path absolute = output.toAbsolutePath().normalize(), ancestor = absolute;
            while (!Files.exists(ancestor, LinkOption.NOFOLLOW_LINKS)) ancestor = ancestor.getParent();
            Path canonical = ancestor.toRealPath().resolve(ancestor.relativize(absolute)).normalize();
            if (canonical.startsWith(root)) throw new IllegalArgumentException("Report output must be outside the --sources directory to preserve archival masters");
            if (Files.exists(output)) try (var walk = Files.walk(root)) {
                for (Path source : walk.filter(path -> Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)).toList())
                    if (Files.isSameFile(output, source)) throw new IllegalArgumentException("Report output refers to a supplied source file");
            }
        }
        if (Files.exists(output) && Files.isSameFile(input, output)) throw new IllegalArgumentException("Report output must not replace the input PDF");
        Files.createDirectories(output.toAbsolutePath().normalize().getParent());
        Files.writeString(output, text, StandardCharsets.UTF_8);
    }
    private static String help() { return """
        DICOM image preservation pilot %1$s
        Usage: java -jar dicom-pdf-%1$s.jar <command> <options>
          create  --input <directory> --output <file.pdf> [--source-role archival-master|deidentified-copy] [--c2pa on|off]
          inspect --input <file.pdf> [--output <inventory.txt>]
          extract --input <file.pdf> --output <new-directory>
          verify  --input <file.pdf> [--sources <original-directory>] [--verapdf <executable>] [--output <report.json>]
          create  --input <directory> --output <file.pdf> --security-config <local-config.json>
          verify-security --input <file.pdf> --security-config <local-config.json> [--sources <directory>] [--output <report.json>]
          renew-pdf --input <file.pdf> --security-config <local-config.json> --output <new-file.pdf>
          renew-evidence --input <file.pdf> --security-config <local-config.json> --output <new-evidence.json> [--previous <evidence.json>]
          verify-evidence --input <file.pdf> --evidence <evidence.json> --security-config <local-config.json> [--output <report.json>]
        Exit status: 0 successful; 1 failure; 2 verify has unresolved references or PDF/A validation not checked.
        verify uses VERAPDF or verapdf on PATH when --verapdf is omitted. PDF/A identification is never treated as validation.
        C2PA is on by default. Without a certificate it uses a new untrusted local identity per archive.
        C2PA currently supports plain and CMS/PDF-signed archives; use --c2pa off with PAdES B-LTA.
        De-identified copies must be supplied in a separate directory/package; the tool does not de-identify or alter sources.
        """.formatted(ApplicationVersion.VERSION); }
}
