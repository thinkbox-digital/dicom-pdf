package digital.thinkbox.dicompdf;

import digital.thinkbox.pdfsecurity.testing.SecurityFixtures;

import java.awt.*;
import java.nio.file.*;
import java.util.List;
import java.util.concurrent.*;
import javax.swing.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class DesktopTest {
    @TempDir Path root;

    @Test void realOnlySpectroscopyCanBeFourierTransformed() {
        var samples = java.nio.ByteBuffer.allocate(3 * Float.BYTES);
        samples.putFloat(1).putFloat(0).putFloat(0).flip();
        var spectrum = new DesktopViewerSpecial.Spectrum(1, 1, 1, 3, "TIME", 1, 1000, samples);

        assertNull(spectrum.trace(1, 1, 1, false).imaginary());
        var transformed = spectrum.trace(1, 1, 1, true);
        double magnitude = 1.0 / 3;
        assertArrayEquals(new double[]{magnitude, magnitude, magnitude, magnitude}, transformed.real(), 1e-12);
    }

    @Test void creatorUsesExistingCliAndRejectsOverwriteAndSourcesAsOutput()throws Exception{
        Path input=Files.createDirectory(root.resolve("source folder")),output=root.resolve("archive file.pdf");
        var request=request(true,input,output,"",false);
        assertEquals(List.of("create","--input",input.toString(),"--output",output.toString(),"--c2pa","on"),request.arguments(root.resolve("report.json")));
        Files.writeString(output,"keep");assertThrows(IllegalArgumentException.class,()->request.arguments(root.resolve("report.json")));assertEquals("keep",Files.readString(output));
        assertThrows(IllegalArgumentException.class,()->request(true,input,input.resolve("nested.pdf"),"",false).arguments(root.resolve("report.json")));
        assertThrows(IllegalArgumentException.class,()->request(true,input,root.resolve("no-extension"),"",false).arguments(root.resolve("report.json")));
    }
    @Test void existingOutputIsReportedBeforeCopyingOrOpeningTheZip()throws Exception{
        Path zip=Files.writeString(root.resolve("corrupt.zip"),"deliberately invalid ZIP");
        Path output=Files.writeString(root.resolve("existing.pdf"),"unchanged archival bytes"),work=Files.createDirectory(root.resolve("work"));
        var request=request(true,zip,output,"",false);
        IllegalArgumentException error=assertThrows(IllegalArgumentException.class,()->request.prepare(work,()->false));
        assertTrue(error.getMessage().contains("Output PDF already exists"));assertFalse(Files.exists(work.resolve("inputs")));
        assertEquals("unchanged archival bytes",Files.readString(output));
    }
    @Test void c2paChoiceSurvivesInputPreparationAndCanBeTurnedOff()throws Exception{
        Path input=Files.createDirectory(root.resolve("input"));Files.writeString(input.resolve("original.bin"),"synthetic");
        var request=new DesktopRequest(true,input.toString(),root.resolve("off.pdf").toString(),"","",false,"",false);
        var prepared=request.prepare(Files.createDirectory(root.resolve("work")),()->false);
        assertFalse(prepared.c2pa());var arguments=prepared.arguments(root.resolve("report.json"));assertEquals("off",arguments.get(arguments.indexOf("--c2pa")+1));
    }
    @Test void securityIsOptInAndTimestampContactNeedsSeparatePermission()throws Exception{
        Path input=Files.createDirectory(root.resolve("sources")),config=root.resolve("security.json");
        Files.writeString(config,"{\"protection\":\"CMS_AND_PDF_TIMESTAMPED\"}");
        assertThrows(IllegalArgumentException.class,()->request(true,input,root.resolve("new.pdf"),config.toString(),false).arguments(root.resolve("report.json")));
        assertTrue(request(true,input,root.resolve("new.pdf"),config.toString(),true).arguments(root.resolve("report.json")).contains("--security-config"));
        Files.writeString(config,"{\"protection\":\"PADES_B_LTA\"}");
        assertThrows(IllegalArgumentException.class,()->request(true,input,root.resolve("new.pdf"),config.toString(),false).arguments(root.resolve("report.json")));
        assertTrue(request(true,input,root.resolve("new.pdf"),config.toString(),true).arguments(root.resolve("report.json")).contains("--security-config"));
        Files.writeString(config,"{\"protection\":\"CMS_AND_PDF\"}");
        assertTrue(request(true,input,root.resolve("new.pdf"),config.toString(),false).arguments(root.resolve("report.json")).contains("--security-config"));
        var error=assertThrows(IllegalArgumentException.class,()->request(true,input,root.resolve("new.pdf"),config.toString(),true).arguments(root.resolve("report.json")));
        assertTrue(error.getMessage().contains("has not been prepared"));
    }
    @Test void validatorUsesReadOnlyVerificationAndConfigurationOverridesSeparateTool()throws Exception{
        Path pdf=Files.writeString(root.resolve("archive.pdf"),"synthetic"),sources=Files.createDirectory(root.resolve("source")),report=root.resolve("report.json"),config=Files.writeString(root.resolve("trust.json"),"{}");
        var plain=new DesktopRequest(false,pdf.toString(),"",sources.toString(),"",false).arguments(report);
        assertEquals("verify",plain.getFirst());assertTrue(plain.containsAll(List.of("--sources",sources.toString(),"--verapdf",SecurityConfiguration.defaultValidator())));
        var security=new DesktopRequest(false,pdf.toString(),"","",config.toString(),false).arguments(report);
        assertEquals("verify-security",security.getFirst());assertFalse(security.contains("--verapdf"));assertFalse(security.contains("--sources"));assertTrue(security.contains("--security-config"));
        assertEquals("synthetic",Files.readString(pdf));
    }
    @Test void resultsKeepMissingEvidenceFailuresAndSourceDiagnosticsSeparate(){
        var rows=ArchiveDesktop.checkRows("{\"sourceBytes\":{\"status\":\"PASS\",\"details\":[\"exact bytes\"]},\"externalSources\":{\"status\":\"NOT_PROVIDED\",\"details\":[\"no inputs\"]},\"dicomStructure\":{\"status\":\"FAIL\",\"details\":[\"source malformed\"]}}");
        assertEquals(List.of("PASS","UNKNOWN","FAIL"),rows.stream().map(ArchiveDesktop.CheckRow::status).toList());
        assertEquals("source malformed",rows.get(2).details());
        var security=ArchiveDesktop.checkRows("{\"assurance\":\"INTEGRITY_ONLY\",\"checks\":{\"manifest.signature\":{\"status\":\"UNKNOWN\",\"code\":\"MISSING_SIGNATURE\"},\"source.signature\":{\"status\":\"NOT_APPLICABLE\",\"code\":\"NO_SIGNATURE\"}}}");
        assertEquals("INTEGRITY_ONLY",security.getFirst().details());assertEquals("UNKNOWN",security.get(1).status());assertEquals("NOT_APPLICABLE",security.get(2).status());
    }
    @Test void savedReportsCannotOverwriteOrPolluteOriginalsIncludingDirectoryAliases()throws Exception{
        Path sources=Files.createDirectory(root.resolve("masters"));
        Path existing=Files.writeString(root.resolve("report.json"),"keep");
        assertThrows(IllegalArgumentException.class,()->DesktopRequest.checkReportDestination(existing,List.of(sources)));
        assertThrows(IllegalArgumentException.class,()->DesktopRequest.checkReportDestination(sources.resolve("nested/report.json"),List.of(sources)));
        assertThrows(IllegalArgumentException.class,()->DesktopRequest.checkReportDestination(Path.of("out/report.json"),List.of()));
        DesktopRequest.checkReportDestination(root.resolve("reports/new.json"),List.of(sources));
        Path alias=root.resolve("alias");Files.createSymbolicLink(alias,sources);
        assertThrows(IllegalArgumentException.class,()->DesktopRequest.checkReportDestination(alias.resolve("nested/report.json"),List.of(sources)));
        assertEquals("keep",Files.readString(existing));
    }
    @Test void formsProvideAccessibleDescriptionsAndTooltipsWithoutAWindow()throws Exception{
        SwingUtilities.invokeAndWait(()->{
            for(String mode:List.of("create","verify")){
                JPanel panel=new ArchiveDesktop(mode).component();int[] controls={0};checkControls(panel,controls);assertEquals(23,controls[0]);assertTrue(c2paCheckbox(panel).isSelected());
                assertEquals(mode.equals("verify")?1:0,tables(panel));
                var footer=(JPanel)((BorderLayout)panel.getLayout()).getLayoutComponent(BorderLayout.SOUTH);
                var version=(JLabel)((BorderLayout)footer.getLayout()).getLayoutComponent(BorderLayout.EAST);
                assertEquals("Version "+ApplicationVersion.VERSION,version.getText());
            }
        });
    }
    @Test void oneSigningPickerShowsTheTimestampChoiceAndMissingSettings()throws Exception{
        Path certificate=Files.writeString(root.resolve("identity.p12"),"synthetic placeholder; never opened");
        Path policy=Files.writeString(root.resolve("timestamped.json"),"{\"pkcs12\":\"identity.p12\",\"passphraseFile\":\"password.txt\",\"protection\":\"CMS_AND_PDF_TIMESTAMPED\",\"tsaUrl\":\"https://tsa.example.test/timestamp\"}");
        var selected=DesktopSigningSelection.read(policy.toString());
        assertEquals(certificate.toString(),selected.certificate());assertEquals(policy.toString(),selected.configuration());assertTrue(selected.timestampRequired());
        assertTrue(DesktopSigningSelection.read(certificate.toString()).configuration().isBlank());
        SwingUtilities.invokeAndWait(()->{
            var panel=new ArchiveDesktop("create").component();
            var field=(JTextField)named(panel,"Signing identity");var consent=(JCheckBox)named(panel,"Trusted timestamp creation");
            var description=(JTextArea)named(panel,"Selected signing policy");
            assertNotNull(field);assertNull(named(panel,"Advanced signing configuration"));assertTrue(consent.isEnabled());
            field.setText(certificate.toString());assertTrue(description.getText().contains("timestamps are off"));
            consent.doClick();assertTrue(consent.isSelected());assertTrue(description.getText().contains("Select a JSON"));
            field.setText(policy.toString());assertTrue(consent.isSelected());assertTrue(description.getText().contains("tsa.example.test"));
            assertEquals(root.resolve("password.txt").toString(),((JTextField)named(panel,"Signing passphrase file")).getText());assertEquals("Add trusted timestamps",consent.getText());
            consent.doClick();assertFalse(consent.isSelected());assertTrue(description.getText().contains("policy requires timestamps"));
            field.setText(root.resolve("missing.json").toString());assertTrue(description.getText().contains("existing"));
        });
        Files.writeString(policy,"{\"pkcs12\":\"identity.p12\",\"protection\":\"PADES_B_LTA\"}");
        assertTrue(assertThrows(IllegalArgumentException.class,()->DesktopSigningSelection.read(policy.toString()).requireTimestampSettings()).getMessage().contains("tsaUrl"));
    }
    @Test void dialogsRememberFoldersPerPurposeAcrossInstancesAndRespectAnExistingSelection()throws Exception{
        Path sources=Files.createDirectory(root.resolve("sources")),certificates=Files.createDirectory(root.resolve("certificates"));
        var preferences=new java.util.HashMap<String,String>();var dialogs=new DesktopFileDialogs(preferences);
        var source=dialogs.chooser("source","");source.setCurrentDirectory(sources.toFile());dialogs.remember("source",source);
        var cert=dialogs.chooser("certificate","");assertEquals(sources.toFile(),cert.getCurrentDirectory());
        cert.setCurrentDirectory(certificates.toFile());dialogs.remember("certificate",cert);
        var next=new DesktopFileDialogs(preferences);
        assertEquals(sources.toFile(),next.chooser("source","").getCurrentDirectory());assertEquals(certificates.toFile(),next.chooser("certificate","").getCurrentDirectory());
        assertEquals(sources.toFile(),next.chooser("certificate",sources.resolve("explicit.p12").toString()).getCurrentDirectory());
    }
    @Test void aCertificateAndPassphraseFileUseTheConfiguredSigningWorker()throws Exception{
        Path inputs=Files.createDirectory(root.resolve("inputs"));Files.writeString(inputs.resolve("source.bin"),"synthetic");
        Path certificate=Files.writeString(root.resolve("identity.p12"),"placeholder"),password=Files.writeString(root.resolve("password.txt"),"synthetic password distinct from archival input");
        var request=new DesktopRequest(true,inputs.toString(),root.resolve("output.pdf").toString(),"","",false,"",true,password.toString());
        assertThrows(IllegalArgumentException.class,()->request.prepare(Files.createDirectory(root.resolve("no-certificate")),()->false));
        var prepared=request.prepare(Files.createDirectory(root.resolve("work")),()->false,certificate.toString());
        var json=com.google.gson.JsonParser.parseString(Files.readString(Path.of(prepared.securityConfig()))).getAsJsonObject();
        assertEquals(certificate.toString(),json.get("pkcs12").getAsString());assertEquals(password.toString(),json.get("passphraseFile").getAsString());
        assertTrue(prepared.arguments(root.resolve("report.json")).contains("--security-config"));
    }
    @Test void guiReportsProfileAndTrustProblemsBeforeAttemptingToStageTheInputs()throws Exception{
        var identity=SecurityFixtures.institution(root.resolve("identity"),false);
        var other=SecurityFixtures.institution(root.resolve("unrelated-ca"),false);
        Path password=Files.writeString(root.resolve("password.txt"),new String(SecurityFixtures.PASSWORD));
        Path trustRoot=Files.writeString(root.resolve("tsa-root.pem"),SecurityFixtures.pem(other.root()));
        Path zip=Files.writeString(root.resolve("invalid.zip"),"Must not be opened while the certificate is incompatible");
        Path output=root.resolve("untouched-output/archive.pdf"),config=root.resolve("signing.json");
        var json=new com.google.gson.JsonObject();json.addProperty("protection","CMS_AND_PDF_TIMESTAMPED");
        json.addProperty("pkcs12",identity.pkcs12().toString());json.addProperty("passphraseFile",password.toString());json.addProperty("tsaUrl","http://127.0.0.1:1/tsa");
        var trusted=new com.google.gson.JsonArray();trusted.add(trustRoot.toString());json.add("trustCertificates",trusted);Files.writeString(config,json.toString());
        JPanel[] panel={null};
        SwingUtilities.invokeAndWait(()->{
            panel[0]=new ArchiveDesktop("create").component();
            ((JTextField)named(panel[0],"Source input")).setText(zip.toString());((JTextField)named(panel[0],"Output PDF")).setText(output.toString());
            ((JTextField)named(panel[0],"Signing identity")).setText(config.toString());((JButton)named(panel[0],"Create archive")).doClick();
        });
        long deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(15);boolean[] complete={false};
        while(System.nanoTime()<deadline){
            SwingUtilities.invokeAndWait(()->complete[0]=((JButton)named(panel[0],"Create archive")).isEnabled());
            if(complete[0])break;Thread.sleep(30);
        }
        assertTrue(complete[0],"Local signing checks must finish without conversion");
        SwingUtilities.invokeAndWait(()->{
            String activity=((JTextArea)named(panel[0],"Operation details")).getText();
            assertTrue(activity.contains("Authority Key Identifier"),activity);assertTrue(activity.contains("Extended Key Usage"),activity);assertTrue(activity.contains("Archive signer trust"),activity);
            assertFalse(activity.contains("Preparing selected inputs"),activity);assertFalse(activity.contains("Starting archive creation"),activity);
        });
        assertFalse(Files.exists(output.getParent()));
    }
    @Test void checkedTimestampOptionUpgradesOrdinarySigningAndPreservesBLtaWithoutEditingTheJson()throws Exception{
        Path input=Files.createDirectory(root.resolve("sources"));Files.writeString(input.resolve("source.bin"),"synthetic original");
        Path config=root.resolve("signing.json");
        String json="{\"protection\":\"CMS_AND_PDF\",\"pkcs12\":\"identity.p12\",\"tsaUrl\":\"https://tsa.example.test/timestamp\",\"trustCertificates\":[\"root.pem\"]}";
        Files.writeString(config,json);
        var on=request(true,input,root.resolve("on.pdf"),config.toString(),true).prepare(Files.createDirectory(root.resolve("on")),()->false);
        var prepared=com.google.gson.JsonParser.parseString(Files.readString(Path.of(on.securityConfig()))).getAsJsonObject();
        assertEquals("CMS_AND_PDF_TIMESTAMPED",prepared.get("protection").getAsString());assertEquals("https://tsa.example.test/timestamp",prepared.get("tsaUrl").getAsString());
        assertTrue(on.arguments(root.resolve("report.json")).contains("--security-config"));assertEquals(json,Files.readString(config));
        var off=request(true,input,root.resolve("off.pdf"),config.toString(),false).prepare(Files.createDirectory(root.resolve("off")),()->false);
        var ordinary=com.google.gson.JsonParser.parseString(Files.readString(Path.of(off.securityConfig()))).getAsJsonObject();
        assertEquals("CMS_AND_PDF",ordinary.get("protection").getAsString());assertFalse(ordinary.has("tsaUrl"));
        Files.writeString(config,json.replace("CMS_AND_PDF","PADES_B_LTA"));
        var lta=request(true,input,root.resolve("lta.pdf"),config.toString(),true).prepare(Files.createDirectory(root.resolve("lta")),()->false);
        assertEquals("PADES_B_LTA",com.google.gson.JsonParser.parseString(Files.readString(Path.of(lta.securityConfig()))).getAsJsonObject().get("protection").getAsString());
        assertThrows(IllegalArgumentException.class,()->request(true,input,root.resolve("refused.pdf"),config.toString(),false).prepare(Files.createDirectory(root.resolve("refused")),()->false));
        Files.writeString(config,"{\"protection\":\"CMS_AND_PDF\",\"pkcs12\":\"identity.p12\"}");
        assertTrue(assertThrows(IllegalArgumentException.class,()->request(true,input,root.resolve("missing.pdf"),config.toString(),true).prepare(Files.createDirectory(root.resolve("missing")),()->false)).getMessage().contains("tsaUrl"));
    }
    private static Component named(Container parent,String name){
        for(Component child:parent.getComponents()){
            if(child instanceof JComponent component&&name.equals(component.getAccessibleContext().getAccessibleName())&&!(child instanceof JLabel label&&label.getLabelFor()!=null))return child;
            if(child instanceof Container container){var found=named(container,name);if(found!=null)return found;}
        }return null;
    }
    private static int tables(Container parent){int count=0;for(Component child:parent.getComponents()){if(child instanceof JTable)count++;if(child instanceof Container container)count+=tables(container);}return count;}
    private static JCheckBox c2paCheckbox(Container parent){for(Component child:parent.getComponents()){if(child instanceof JCheckBox box&&box.getText().equals("Include C2PA Content Credentials"))return box;if(child instanceof Container container){var box=c2paCheckbox(container);if(box!=null)return box;}}return null;}
    private static void checkControls(Container parent,int[] count){
        for(Component child:parent.getComponents()){
            if(child instanceof JScrollPane scroll)assertEquals(JScrollPane.HORIZONTAL_SCROLLBAR_NEVER,scroll.getHorizontalScrollBarPolicy());
            if(child instanceof JButton b&&!b.getText().isBlank()||child instanceof JTextField||child instanceof JComboBox<?>||child instanceof JCheckBox){
                JComponent item=(JComponent)child;assertNotNull(item.getToolTipText(),item.getClass().getName());assertNotNull(item.getAccessibleContext().getAccessibleName());assertNotNull(item.getAccessibleContext().getAccessibleDescription());count[0]++;
            }
            if(child instanceof Container container)checkControls(container,count);
        }
    }
    @Test void subprocessPreservesArgumentsAndUtf8AndReportsFailure()throws Exception{
        StringBuilder log=new StringBuilder();var runner=new DesktopProcess();
        assertEquals(7,runner.execute(DesktopProcess.javaCommand(Fixture.class.getName(),List.of("echo","a b;$literal","Médical")),log::append));
        assertTrue(log.toString().contains("a b;$literal|Médical"));assertFalse(runner.stopped());
    }
    @Test void stopBeforeAndDuringExecutionDoesNotReportSuccess()throws Exception{
        DesktopProcess before=new DesktopProcess();before.stop();assertEquals(130,before.execute(List.of("not-an-executable"),s->{}));
        DesktopProcess running=new DesktopProcess();CountDownLatch ready=new CountDownLatch(1);
        try(var executor=Executors.newSingleThreadExecutor()){
            Future<Integer> result=executor.submit(()->running.execute(DesktopProcess.javaCommand(Fixture.class.getName(),List.of("wait")),s->ready.countDown()));
            assertTrue(ready.await(15,TimeUnit.SECONDS));running.stop();
            try{assertNotEquals(0,result.get(10,TimeUnit.SECONDS));}catch(ExecutionException error){assertTrue(running.stopped());}
            assertTrue(running.stopped());
        }
    }
    @Test void desktopEntryPointIsSeparateFromTheCliAndOffersHeadlessHelp()throws Exception{
        var bytes=new java.io.ByteArrayOutputStream();var out=new java.io.PrintStream(bytes);
        assertEquals(0,Main.run(new String[]{"--help"},out,out));assertTrue(bytes.toString().contains("verify"));
        assertEquals(1,Main.run(new String[]{"gui","unknown"},out,out));
        assertEquals(1,Main.run(new String[]{"gui","create","unexpected"},out,out));
        StringBuilder help=new StringBuilder();assertEquals(0,new DesktopProcess().execute(DesktopProcess.javaCommand(ArchiveDesktop.class.getName(),List.of("--help")),help::append));
        assertTrue(help.toString().contains("desktop.jar [create|verify]"));
        assertThrows(IllegalArgumentException.class,()->ArchiveDesktop.launch("unknown"));
    }
    private DesktopRequest request(boolean create,Path input,Path output,String security,boolean timestamp){return new DesktopRequest(create,input.toString(),output.toString(),"",security,timestamp);}
    public static class Fixture {
        public static void main(String[] args)throws Exception{
            if(args[0].equals("wait")){System.out.println("ready");System.out.flush();Thread.sleep(60000);}
            else{System.out.println(args[1]+"|"+args[2]);System.exit(7);}
        }
    }
}
