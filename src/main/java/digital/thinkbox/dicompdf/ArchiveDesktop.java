package digital.thinkbox.dicompdf;

import com.google.gson.*;
import java.awt.*;
import java.awt.event.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.ArrayList;
import java.util.List;
import javax.swing.*;
import javax.swing.filechooser.FileNameExtensionFilter;
import javax.swing.table.DefaultTableModel;

/** Local creator/validator desktop. No new imaging, signing or validation engine. */
public final class ArchiveDesktop {
    private static final int LOG_LIMIT=250_000;
    private final JPanel root=new JPanel(new BorderLayout(12,12));
    private final JTabbedPane modes=new ContentTabs(),results=new JTabbedPane();
    private final List<JComponent> inputs=new ArrayList<>();
    private final DesktopFileDialogs fileDialogs=new DesktopFileDialogs();
    private final JTextField source=field("Source input","Choose a single file, a directory of images, or a ZIP. Directory subfolders are included. Originals remain unchanged."),
            output=field("Output PDF","Output .pdf file outside the source folder. Replacing an existing PDF requires confirmation and happens only after conversion succeeds."),
            signing=field("Signing identity","Choose a .p12/.pfx certificate, or an advanced .json configuration containing the certificate, timestamps and trust policy. Keep credentials outside source inputs."),
            passphrase=field("Signing passphrase file","Optional UTF-8 file containing the PKCS12 password. Populated from JSON; browsing overrides its path for this run. With a simple certificate, leave blank to enter its password on Create."),
            archive=field("Archive PDF","Existing DICOM-in-PDF archive to verify. Validation never modifies it."),
            originals=field("Original source input","Optional original file, directory or ZIP for byte-for-byte comparison and supplied-file inventory reconciliation."),
            trust=field("Verification configuration","Optional local JSON configuration selecting expected signature protection, trust certificates, CRLs and veraPDF. No signing key is needed for verification.");
    private final JCheckBox c2pa=new JCheckBox("Include C2PA Content Credentials",true);
    private final JCheckBox timestamp=new JCheckBox("Add trusted timestamps");
    private final JTextArea signingDescription=note("");
    private final JButton create=button("Create archive",KeyEvent.VK_C,"Preserve the supplied files in a new PDF using the existing creator."),
            verify=button("Validate archive",KeyEvent.VK_V,"Run archive integrity, metadata, reference and PDF/A checks; add signature/trust checks when configured."),
            stop=button("Stop",KeyEvent.VK_S,"Stop the active process and its validator subprocesses. A stopped run is not reported as successful."),
            save=button("Save report…",KeyEvent.VK_R,"Save the completed validator's JSON report to a new file."),
            open=button("Open PDF",KeyEvent.VK_O,"Open the last completed archive in the system's PDF reader."),
            folder=button("Open folder",KeyEvent.VK_F,"Open the folder containing the last completed archive."),
            help=button("Help",KeyEvent.VK_H,"Show creation, verification, privacy and result-status guidance.");
    private final JLabel status=new JLabel("Ready"),summary=new JLabel("Choose Create or Validate to begin.");
    private final JTextArea details=new JTextArea(10,60);
    private JComponent validationView,activityView;
    private boolean activeCreating;
    private final JProgressBar progress=new JProgressBar();
    private DesktopActivity activity;
    private final Timer activityTimer=new Timer(1000,event->updateActivity());
    private final DefaultTableModel checks=new DefaultTableModel(new String[]{"Check","Result","Evidence / explanation"},0){
        @Override public boolean isCellEditable(int row,int column){return false;}
    };
    private final JTable table=new JTable(checks);
    private final JTextArea evidence=new JTextArea(3,40);
    private volatile DesktopProcess active;
    private boolean closing;
    private JFrame frame;
    private String report;
    private Path lastPdf;
    private List<Path> reportSourceRoots=List.of();

    public static void main(String[] args){
        String usage="Usage: java -jar dicom-pdf-"+ApplicationVersion.VERSION+"-desktop.jar [create|verify]";
        if(args.length==1&&List.of("--help","help").contains(args[0])){
            System.out.println("Archival DICOM in PDF — Creator and Validator\n"+usage
                    +"\nRequires Java 21 and a graphical desktop. Command-line automation uses dicom-pdf-"
                    +ApplicationVersion.VERSION+".jar.");return;
        }
        if(args.length>1||args.length==1&&!List.of("create","verify").contains(args[0])){
            System.err.println(usage);System.exit(1);return;
        }
        int code=launch(args.length>0?args[0]:"create");if(code!=0)System.exit(code);
    }
    static int launch(String mode){
        if(!List.of("create","verify").contains(mode))throw new IllegalArgumentException("GUI mode must be create or verify.");
        if(GraphicsEnvironment.isHeadless()){System.err.println("The desktop interface needs a graphical desktop. Use create or verify from the command line on a headless system.");return 1;}
        SwingUtilities.invokeLater(()->{
            try{UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName());}catch(Exception ignored){}
            new ArchiveDesktop(mode).show();
        });return 0;
    }
    ArchiveDesktop(String mode){
        root.setBorder(BorderFactory.createEmptyBorder(16,16,16,16));
        JPanel header=new JPanel(new BorderLayout(8,8));
        JLabel title=new JLabel("Archival DICOM in PDF");title.setFont(title.getFont().deriveFont(Font.BOLD,24));
        var icon=ArchiveDesktop.class.getResource("/icons/icon-48.png");if(icon!=null){title.setIcon(new ImageIcon(icon));title.setIconTextGap(12);}
        header.add(title,BorderLayout.NORTH);
        header.add(new JLabel("Preserve original medical imaging records. Verify their integrity and available authenticity evidence."),BorderLayout.CENTER);
        header.add(help,BorderLayout.EAST);root.add(header,BorderLayout.NORTH);
        describe(timestamp,"Trusted timestamp creation","Turn timestamping on using the selected JSON's timestamp service and TSA trust settings. Only cryptographic imprints are sent. Missing settings or a failed timestamp stop creation.");inputs.add(timestamp);
        JPanel creation=form();int r=0;
        row(creation,r++,"File, directory or ZIP",source,true,false,null);
        row(creation,r++,"Output PDF",output,false,true,"pdf");
        describe(c2pa,"C2PA Content Credentials","On by default. Signs archive export provenance. Without an institutional certificate, a new untrusted local identity is used for each archive. With PAdES B-LTA, the final document timestamp also covers C2PA. Does not authenticate acquisition.");inputs.add(c2pa);
        wide(creation,r++,c2pa);
        row(creation,r++,"Signing identity or JSON policy (optional)",signing,false,false,"p12,pfx,json");
        row(creation,r++,"Passphrase file (optional)",passphrase,false,false,null);
        describe(signingDescription,"Selected signing policy","Shows the selected certificate, protection and whether timestamps are requested. No credentials are opened or passwords read here.");
        signingDescription.setRows(3);
        wide(creation,r++,signingDescription);wide(creation,r,timestamp);
        signing.getDocument().addDocumentListener(new javax.swing.event.DocumentListener(){
            public void insertUpdate(javax.swing.event.DocumentEvent event){signingChanged(true);}
            public void removeUpdate(javax.swing.event.DocumentEvent event){signingChanged(true);}
            public void changedUpdate(javax.swing.event.DocumentEvent event){signingChanged(true);}
        });timestamp.addActionListener(event->signingChanged());signingChanged();
        passphrase.getDocument().addDocumentListener(new javax.swing.event.DocumentListener(){
            public void insertUpdate(javax.swing.event.DocumentEvent event){signingChanged();}
            public void removeUpdate(javax.swing.event.DocumentEvent event){signingChanged();}
            public void changedUpdate(javax.swing.event.DocumentEvent event){signingChanged();}
        });
        JPanel validation=form();r=0;
        row(validation,r++,"Archive PDF",archive,false,false,"pdf");
        row(validation,r++,"Original file, directory or ZIP (optional)",originals,true,false,null);
        row(validation,r++,"Verification configuration (optional)",trust,false,false,"json");
        wide(validation,r++,note("Originals enable an external source comparison. Without them, that check is UNKNOWN. PDF/A validation uses the configured local veraPDF installation automatically."));
        wide(validation,r,note("A verification configuration enables signature, timestamp and trust checks. Set the veraPDF path in the configuration or VERAPDF, or install verapdf on PATH. Verification is offline."));
        modes.addTab("Create",wrap(creation,create));modes.setToolTipTextAt(0,"Create a new archival PDF from a folder of supplied files.");modes.setMnemonicAt(0,KeyEvent.VK_1);
        modes.addTab("Validate",wrap(validation,verify));modes.setToolTipTextAt(1,"Check an existing archive without changing it.");modes.setMnemonicAt(1,KeyEvent.VK_2);
        modes.setSelectedIndex("verify".equals(mode)?1:0);describe(modes,"Operation","Choose archive creation or validation.");
        JPanel body=new JPanel(new BorderLayout(10,10));body.add(modes,BorderLayout.NORTH);body.add(resultPanel(),BorderLayout.CENTER);root.add(body,BorderLayout.CENTER);
        modes.addChangeListener(e->resultMode());resultMode();
        JPanel footer=new JPanel(new BorderLayout(8,8));
        footer.add(new JLabel("Local processing • No automatic uploads • Verification does not establish clinical study completeness."),BorderLayout.CENTER);
        footer.add(new JLabel("Version "+ApplicationVersion.VERSION),BorderLayout.EAST);
        root.add(footer,BorderLayout.SOUTH);
        create.addActionListener(e->start(true));verify.addActionListener(e->start(false));
        stop.addActionListener(e->{if(active!=null){status.setText("Stopping…");stop.setEnabled(false);active.stop();}});
        save.addActionListener(e->saveReport());open.addActionListener(e->open(lastPdf));folder.addActionListener(e->open(lastPdf==null?null:lastPdf.getParent()));
        help.addActionListener(e->JOptionPane.showMessageDialog(root,HELP,"Archival DICOM in PDF — Help",JOptionPane.INFORMATION_MESSAGE));
        stop.setEnabled(false);save.setEnabled(false);open.setEnabled(false);folder.setEnabled(false);
    }
    JPanel component(){return root;}
    private void show(){
        frame=new JFrame("Archival DICOM in PDF — Creator and Validator");frame.setContentPane(root);
        List<Image> icons=new ArrayList<>();for(int size:List.of(16,32,48,128)){
            var resource=ArchiveDesktop.class.getResource("/icons/icon-"+size+".png");if(resource!=null)icons.add(new ImageIcon(resource).getImage());
        }frame.setIconImages(icons);
        frame.setDefaultCloseOperation(WindowConstants.DO_NOTHING_ON_CLOSE);
        frame.addWindowListener(new WindowAdapter(){@Override public void windowClosing(WindowEvent e){
            if(active==null)frame.dispose();else if(JOptionPane.showConfirmDialog(frame,"Stop the active operation and close?","Operation running",JOptionPane.YES_NO_OPTION)==JOptionPane.YES_OPTION){closing=true;active.stop();status.setText("Stopping before closing…");}
        }});
        Rectangle screen=GraphicsEnvironment.getLocalGraphicsEnvironment().getMaximumWindowBounds();
        frame.pack();frame.setSize(Math.min((int)Math.round(1120*1.30),screen.width),Math.min(Math.max(1100,frame.getPreferredSize().height),screen.height));frame.setMinimumSize(new Dimension(Math.min(740,screen.width),Math.min(600,screen.height)));
        frame.setLocationRelativeTo(null);frame.setVisible(true);
    }
    private JComponent resultPanel(){
        JPanel panel=new JPanel(new BorderLayout(8,8));panel.setBorder(BorderFactory.createTitledBorder("Progress and results"));
        JPanel actions=new JPanel(new FlowLayout(FlowLayout.LEFT,8,0));
        for(JButton b:List.of(stop,save,open,folder))actions.add(b);
        progress.setPreferredSize(new Dimension(100,18));describe(progress,"Operation progress","Indeterminate while running; no percentage is estimated.");actions.add(progress);
        describe(status,"Operation status","Current operation state. Individual checks are reported separately below.");actions.add(status);panel.add(actions,BorderLayout.NORTH);
        describe(table,"Verification checks","Each row reports a separate check. Select a row for its complete evidence below.");table.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
        table.setAutoCreateRowSorter(true);table.getColumnModel().getColumn(0).setPreferredWidth(220);table.getColumnModel().getColumn(1).setPreferredWidth(100);table.getColumnModel().getColumn(2).setPreferredWidth(480);
        evidence.setEditable(false);evidence.setLineWrap(true);evidence.setWrapStyleWord(true);describe(evidence,"Selected check evidence","Full explanation for the selected verification result. Text can be selected and copied.");
        table.getSelectionModel().addListSelectionListener(e->{int row=table.getSelectedRow();evidence.setText(row<0?"":String.valueOf(checks.getValueAt(table.convertRowIndexToModel(row),2)));evidence.setCaretPosition(0);});
        JPanel overview=new JPanel(new BorderLayout(8,8));describe(summary,"Run summary","Overall operation outcome; a completed run does not mean every check passed.");
        table.setAutoResizeMode(JTable.AUTO_RESIZE_LAST_COLUMN);
        JScrollPane tableScroll=scroll(table);tableScroll.setPreferredSize(new Dimension(1000,table.getRowHeight()*8+28));
        JSplitPane findings=new JSplitPane(JSplitPane.VERTICAL_SPLIT,tableScroll,scroll(evidence));findings.setResizeWeight(1.0);overview.add(findings,BorderLayout.CENTER);
        details.setEditable(false);details.setLineWrap(true);details.setWrapStyleWord(true);describe(details,"Operation details","Local CLI output, limited to the most recent 250,000 characters. May contain sensitive source information. Not saved automatically.");
        validationView=overview;activityView=scroll(details);
        describe(results,"Result views","Creation shows activity only. Validation adds structured check results and evidence.");
        JPanel content=new JPanel(new BorderLayout(8,8));content.add(summary,BorderLayout.NORTH);content.add(results,BorderLayout.CENTER);panel.add(content,BorderLayout.CENTER);return panel;
    }
    private void resultMode(){
        if(validationView==null)return;
        boolean validating=active==null?modes.getSelectedIndex()==1:!activeCreating;
        boolean detailsSelected=results.getSelectedIndex()>=0&&results.getTitleAt(results.getSelectedIndex()).equals("Details");
        results.removeAll();
        if(validating){results.addTab("Summary",validationView);results.setToolTipTextAt(0,"Individual validation checks and evidence.");}
        results.addTab(validating?"Details":"Activity",activityView);
        results.setToolTipTextAt(results.getTabCount()-1,"Local operation output; may contain sensitive metadata.");
        if(validating&&detailsSelected)results.setSelectedIndex(1);save.setVisible(validating);
        root.revalidate();root.repaint();
    }
    private void start(boolean creating){
        if(active!=null)return;
        final String certificate,policy;
        try{
            var selected=DesktopSigningSelection.read(creating?signing.getText():"");
            certificate=selected.configuration().isBlank()?selected.certificate():"";
            policy=creating?selected.configuration():trust.getText();
            if(creating&&timestamp.isSelected())selected.requireTimestampSettings();
            if(creating&&selected.protection()==null&&!passphrase.getText().isBlank())throw new IllegalArgumentException("Select a signing certificate or JSON for the passphrase file.");
            if(creating&&selected.timestampRequired()&&!timestamp.isSelected())throw new IllegalArgumentException("This policy requires timestamps. Check Add trusted timestamps to proceed.");
            if(creating&&!policy.isBlank()&&passphrase.getText().isBlank())throw new IllegalArgumentException("Choose the passphrase file for this signing configuration.");
            if(creating&&!passphrase.getText().isBlank()&&!Files.isRegularFile(Path.of(passphrase.getText().strip())))throw new IllegalArgumentException("Choose an existing signing passphrase file.");
        }catch(Exception error){message("Check signing selection",error);return;}
        final DesktopReplacement replacement;
        try{
            replacement=creating&&!output.getText().isBlank()&&!source.getText().isBlank()
                    ?DesktopReplacement.inspect(Path.of(source.getText().strip()),Path.of(output.getText().strip())):null;
        }catch(Exception error){message("Cannot replace the output PDF",error);return;}
        if(replacement!=null&&!confirmReplacement(replacement.destination())){
            status.setText("Ready");summary.setToolTipText(null);summary.setText("Replacement cancelled. The existing PDF is unchanged.");return;
        }
        final boolean promptPassword=!certificate.isBlank()&&passphrase.getText().isBlank();
        final char[] password=promptPassword?signingPassword():null;
        if(promptPassword&&password==null)return;
        DesktopRequest request=new DesktopRequest(creating,creating?source.getText():archive.getText(),output.getText(),originals.getText(),policy,timestamp.isSelected(),"",c2pa.isSelected(),creating?passphrase.getText().strip():"");
        DesktopProcess operation=new DesktopProcess();active=operation;activeCreating=creating;activity=new DesktopActivity(System.nanoTime());report=null;lastPdf=null;reportSourceRoots=List.of();resultMode();
        details.setText("");checks.setRowCount(0);evidence.setText("");summary.setToolTipText(null);summary.setText(creating?"Creating archive…":"Validating archive…");
        status.setText(creating?"Checking signing…":"Preparing…");busy(true);
        new SwingWorker<Integer,String>(){
            private String resultJson;
            @Override protected Integer doInBackground()throws Exception{
                try(DesktopReplacement transaction=replacement){
                    Path directory=Files.createTempDirectory("dicom-pdf-desktop-");int code;
                    try{
                        if(creating){publish("Progress: Checking signing setup…\n");request.checkSigning(certificate,password);}
                        DesktopRequest effective=request;
                        if(transaction!=null){
                            Path staged=transaction.stage(operation::stopped);
                            effective=new DesktopRequest(true,request.input(),staged.toString(),request.sources(),request.securityConfig(),request.timestamping(),request.importProvenance(),request.c2pa(),request.passphraseFile());
                        }
                        publish("Progress: Preparing selected inputs…\n");
                        DesktopRequest prepared=effective.prepare(directory,operation::stopped,certificate,message->publish("Progress: "+message+"\n"));
                        Path result=directory.resolve("report.json");List<String> arguments=new ArrayList<>(prepared.arguments(result));
                        boolean directCertificate=!certificate.isBlank()&&prepared.securityConfig().isBlank();
                        if(directCertificate)arguments.addAll(List.of("--certificate",Path.of(certificate).toAbsolutePath().toString()));
                        String entryPoint=directCertificate||!creating&&policy.isBlank()?DesktopSigningMain.class.getName():Main.class.getName();
                        publish(creating?"Progress: Starting archive creation…\n":"Progress: Starting archive validation…\n");
                        code=operation.execute(DesktopProcess.javaCommand(entryPoint,arguments),this::publish,password);
                        if(!creating&&!operation.stopped()&&Files.isRegularFile(result)){
                            if(Files.size(result)>16*1024*1024)throw new IllegalStateException("Validator report exceeds the desktop display limit.");
                            resultJson=Files.readString(result,StandardCharsets.UTF_8);
                        }
                    }finally{
                        if(password!=null)java.util.Arrays.fill(password,'\0');DesktopInputs.remove(directory);
                    }
                    if(code==0&&transaction!=null&&!operation.stopped()){
                        publish("Replacing the confirmed output PDF…\n");transaction.commit(operation::stopped);publish("Saved "+request.output()+"\n");
                    }
                    return code;
                }
            }
            @Override protected void process(List<String> chunks){
                for(String chunk:chunks){activity.accept(chunk,System.nanoTime());append(chunk);}
                updateActivity();
            }
            @Override protected void done(){
                try{
                    int code=get();
                    if(operation.stopped()&&(replacement==null||!replacement.committed())){status.setText("Stopped");summary.setText("Operation stopped. No successful result is claimed; inspect any output before use.");}
                    else{
                        report=resultJson;if(report!=null){showChecks(report);if(!request.sources().isBlank())reportSourceRoots=List.of(Path.of(request.sources().strip()));}
                        if(creating&&code==0){
                            archive.setText(request.output().strip());originals.setText(request.input().strip());trust.setText(request.securityConfig().strip());
                        }
                        status.setText(code==0?"Completed":code==2?"Review needed":"Failed");
                        summary.setText(creating?(code==0?createdSummary(activity.creationSummary(),!certificate.isBlank()||!request.securityConfig().isBlank()):"Archive creation failed. See Activity."):
                                code==0?"Validation completed. Review each check; source findings can differ from archive integrity.":code==2?"Validation needs review: one or more checks are unknown or references need attention.":"Validation reported a failure. Review the checks and Details.");
                        if(code==0||!creating&&code==2)lastPdf=Path.of(request.creating()?request.output():request.input()).toAbsolutePath().normalize();
                    }
                }catch(Exception error){
                    Throwable cause=error.getCause()==null?error:error.getCause();String reason=cause.getMessage()==null?cause.getClass().getSimpleName():cause.getMessage();
                    status.setText(operation.stopped()?"Stopped":"Failed");summary.setText(operation.stopped()?"Operation stopped.":(creating?"Creation failed: ":"Validation failed: ")+reason);
                    if(creating&&reason.startsWith("Signing setup failed before creation:"))summary.setText("Signing setup needs attention. See Activity for all checks.");
                    summary.setToolTipText(reason);
                    append("\n"+reason+"\n");results.setSelectedIndex(results.getTabCount()-1);
                }finally{
                    if(password!=null)java.util.Arrays.fill(password,'\0');active=null;busy(false);resultMode();if(closing&&frame!=null)frame.dispose();
                }
            }
        }.execute();
    }
    private void showChecks(String json){
        for(CheckRow row:checkRows(json))checks.addRow(new Object[]{row.name(),row.status(),row.details()});
        if(checks.getRowCount()>0)table.setRowSelectionInterval(0,0);
    }
    private String createdSummary(String text,boolean signed){
        var counts=java.util.regex.Pattern.compile(": (\\d+) supplied and embedded; (\\d+) displayed; (\\d+) rejected for display\\.").matcher(text);
        return (signed?"Signed archive created. ":"Archive created. ")+(counts.find()?counts.group(1)+" supplied files preserved; "+counts.group(2)+" reference images; "+counts.group(3)+" without previews. ":"")+"Validate tab is ready.";
    }
    record CheckRow(String name,String status,String details){}
    static List<CheckRow> checkRows(String json){
        JsonObject root=JsonParser.parseString(json).getAsJsonObject();JsonObject values=root.has("checks")?root.getAsJsonObject("checks"):root;
        if(!root.has("checks")&&root.has("c2pa")){values=values.deepCopy();for(var entry:root.getAsJsonObject("c2pa").entrySet())values.add(entry.getKey(),entry.getValue());values.remove("c2pa");}
        List<CheckRow> rows=new ArrayList<>();
        if(root.has("assurance"))rows.add(new CheckRow("Authentication assurance","INFO",root.get("assurance").getAsString()));
        for(var entry:values.entrySet()){
            if(!entry.getValue().isJsonObject())continue;JsonObject item=entry.getValue().getAsJsonObject();if(!item.has("status"))continue;
            String state=item.get("status").getAsString();if(List.of("NOT_CHECKED","NOT_PROVIDED").contains(state))state="UNKNOWN";
            String explanation=item.has("details")?String.join("\n",item.getAsJsonArray("details").asList().stream().map(JsonElement::getAsString).toList()):item.has("code")?item.get("code").getAsString():"";
            rows.add(new CheckRow(checkName(entry.getKey()),state,explanation));
        }
        return List.copyOf(rows);
    }
    private static String checkName(String key){return switch(key){
        case "pdfa4f"->"PDF/A-4f conformance";case "sourceBytes"->"Embedded original integrity";case "externalSources"->"External source comparison";
        case "metadataAccuracy"->"Metadata and preview mappings";case "unresolvedReferences"->"Referenced objects";
        case "dicomInputConformance"->"Source diagnostics (existing subset)";case "dicomStructure"->"Source structure (existing subset)";
        case "c2pa.signature"->"C2PA claim signature";case "c2pa.binding"->"C2PA archive binding";case "c2pa.trust"->"C2PA signer trust";case "c2pa.timestamp"->"C2PA trusted time";case "c2pa.validation"->"C2PA validation";case "c2pa.presence"->"C2PA credentials";
        default->key;
    };}
    private void append(String text){
        if(text.length()>LOG_LIMIT)text=text.substring(text.length()-LOG_LIMIT);details.append(text);
        int excess=details.getDocument().getLength()-LOG_LIMIT;
        if(excess>0)try{details.getDocument().remove(0,excess);}catch(javax.swing.text.BadLocationException ignored){}
        details.setCaretPosition(details.getDocument().getLength());
    }
    private void updateActivity(){
        if(active==null||activity==null)return;
        long now=System.nanoTime();progress.setString(activity.elapsed(now));
        status.setText(active.stopped()?"Stopping…":"Running — "+activity.elapsed(now)+" elapsed");
        summary.setText(activity.phase());
        if(!active.stopped()){
            String notice=activity.heartbeat(now);if(!notice.isEmpty())append(notice);
        }
    }
    private void busy(boolean running){
        inputs.forEach(input->input.setEnabled(!running));create.setEnabled(!running);verify.setEnabled(!running);stop.setEnabled(running);
        if(!running)signingChanged();
        progress.setIndeterminate(running);progress.setStringPainted(running);
        if(running){progress.setString("00:00");activityTimer.start();}else activityTimer.stop();
        save.setEnabled(!running&&report!=null);open.setEnabled(!running&&lastPdf!=null&&Desktop.isDesktopSupported());folder.setEnabled(open.isEnabled());
    }
    private void signingChanged(){
        signingChanged(false);
    }
    private void signingChanged(boolean selectionChanged){
        timestamp.setEnabled(active==null);
        try{
            var selected=DesktopSigningSelection.read(signing.getText());
            if(selectionChanged){passphrase.setText(selected.passphraseFile());timestamp.setSelected(selected.tsaUrl()!=null||selected.timestampRequired());}
            String description=selected.description(timestamp.isSelected());
            if(selected.configuration().isBlank()&&!passphrase.getText().isBlank())description=description.replace("Password requested on Create.","Password read from the selected passphrase file.");
            signingDescription.setText(description);
        }catch(Exception error){signingDescription.setText(error.getMessage());}
        signingDescription.setCaretPosition(0);root.revalidate();
    }
    private void saveReport(){
        if(report==null)return;JFileChooser chooser=fileDialogs.chooser("report","",Path.of("target"));chooser.setDialogTitle("Save validation report");chooser.setFileFilter(new FileNameExtensionFilter("JSON report (*.json)","json"));
        chooser.setSelectedFile(new java.io.File(chooser.getCurrentDirectory(),"validation-report.json"));
        int choice=chooser.showSaveDialog(root);fileDialogs.remember("report",chooser);if(choice!=JFileChooser.APPROVE_OPTION)return;
        Path destination=chooser.getSelectedFile().toPath();
        if(!destination.getFileName().toString().toLowerCase(java.util.Locale.ROOT).endsWith(".json"))destination=destination.resolveSibling(destination.getFileName()+".json");
        try{
            DesktopRequest.checkReportDestination(destination,reportSourceRoots);
            Files.createDirectories(destination.toAbsolutePath().getParent());Files.writeString(destination,report,StandardCharsets.UTF_8,StandardOpenOption.CREATE_NEW);
            status.setText("Report saved");
        }catch(Exception error){message("Report was not saved",error);}
    }
    private void open(Path path){if(path==null)return;try{Desktop.getDesktop().open(path.toFile());}catch(Exception error){message("Could not open the file or folder",error);}}
    private boolean confirmReplacement(Path destination){
        JTextArea explanation=new JTextArea("Replace this existing PDF?\n\n"+destination+"\n\nThe current file will remain intact until the replacement has been created successfully.",5,56);
        explanation.setEditable(false);explanation.setLineWrap(true);explanation.setWrapStyleWord(true);explanation.setOpaque(false);explanation.setFont(UIManager.getFont("Label.font"));
        describe(explanation,"PDF replacement confirmation","Review the exact output path. Cancel preserves the existing file.");
        return JOptionPane.showOptionDialog(root,explanation,"Replace existing PDF?",JOptionPane.DEFAULT_OPTION,JOptionPane.QUESTION_MESSAGE,null,new Object[]{"Replace","Cancel"},"Cancel")==0;
    }
    private char[] signingPassword(){
        JPasswordField password=new JPasswordField(28);describe(password,"Signing certificate password","Password that unlocks the selected certificate. It is not saved or logged.");
        JLabel label=new JLabel("Signing certificate password:");label.setLabelFor(password);
        JPanel content=new JPanel(new BorderLayout(0,8));content.add(label,BorderLayout.NORTH);content.add(password,BorderLayout.CENTER);
        JOptionPane pane=new JOptionPane(content,JOptionPane.PLAIN_MESSAGE,JOptionPane.OK_CANCEL_OPTION){@Override public void selectInitialValue(){password.requestFocusInWindow();}};
        JDialog dialog=pane.createDialog(root,"Signing certificate password");
        dialog.addWindowFocusListener(new WindowAdapter(){@Override public void windowGainedFocus(WindowEvent event){SwingUtilities.invokeLater(password::requestFocusInWindow);}});
        try{dialog.setVisible(true);return Integer.valueOf(JOptionPane.OK_OPTION).equals(pane.getValue())?password.getPassword():null;}
        finally{password.setText("");dialog.dispose();}
    }
    private void message(String title,Exception error){JOptionPane.showMessageDialog(root,error.getMessage(),title,JOptionPane.ERROR_MESSAGE);}
    private static JScrollPane scroll(Component content){return new JScrollPane(content,JScrollPane.VERTICAL_SCROLLBAR_AS_NEEDED,JScrollPane.HORIZONTAL_SCROLLBAR_NEVER);}
    private static final class ContentTabs extends JTabbedPane {
        @Override public Dimension getPreferredSize(){
            Dimension size=super.getPreferredSize();Component selected=getSelectedComponent();
            if(selected!=null){int tallest=0;for(int i=0;i<getTabCount();i++)tallest=Math.max(tallest,getComponentAt(i).getPreferredSize().height);size.height+=selected.getPreferredSize().height-tallest;}
            return size;
        }
    }
    private static final class WidthPanel extends JPanel implements Scrollable{
        WidthPanel(){super(new BorderLayout());}
        @Override public Dimension getPreferredScrollableViewportSize(){return getPreferredSize();}
        @Override public int getScrollableUnitIncrement(Rectangle visible,int orientation,int direction){return 18;}
        @Override public int getScrollableBlockIncrement(Rectangle visible,int orientation,int direction){return Math.max(18,visible.height-18);}
        @Override public boolean getScrollableTracksViewportWidth(){return true;}
        @Override public boolean getScrollableTracksViewportHeight(){return false;}
    }
    private JTextField field(String name,String tip){JTextField field=new JTextField(24);field.setMinimumSize(new Dimension(0,field.getPreferredSize().height));describe(field,name,tip);inputs.add(field);return field;}
    private static JButton button(String name,int mnemonic,String tip){JButton b=new JButton(name);b.setMnemonic(mnemonic);describe(b,name,tip);return b;}
    private static void describe(JComponent item,String name,String tip){item.setToolTipText(tip);item.getAccessibleContext().setAccessibleName(name);item.getAccessibleContext().setAccessibleDescription(tip);}
    private static JTextArea note(String text){JTextArea note=new JTextArea(text,2,50);note.setEditable(false);note.setLineWrap(true);note.setWrapStyleWord(true);note.setOpaque(false);note.setFont(UIManager.getFont("Label.font"));note.setFocusable(false);return note;}
    private static JPanel form(){JPanel panel=new JPanel(new GridBagLayout());panel.setBorder(BorderFactory.createEmptyBorder(12,12,12,12));return panel;}
    private static JPanel wrap(JPanel form,JButton action){
        JPanel aligned=new WidthPanel();aligned.add(form,BorderLayout.NORTH);
        JScrollPane scroll=scroll(aligned);scroll.setBorder(BorderFactory.createEmptyBorder());scroll.getVerticalScrollBar().setUnitIncrement(18);
        JPanel wrapper=new JPanel(new BorderLayout());wrapper.add(scroll,BorderLayout.CENTER);
        JPanel actions=new JPanel(new FlowLayout(FlowLayout.RIGHT,12,8));actions.add(action);wrapper.add(actions,BorderLayout.SOUTH);return wrapper;
    }
    private static GridBagConstraints cell(int row,int column){GridBagConstraints c=new GridBagConstraints();c.gridy=row;c.gridx=column;c.insets=new Insets(5,4,5,4);c.anchor=GridBagConstraints.NORTHWEST;return c;}
    private void row(JPanel panel,int row,String title,JComponent value,boolean directory,boolean saving,String extension){
        JLabel label=new JLabel(title);label.setLabelFor(value);label.setToolTipText(value.getToolTipText());panel.add(label,cell(row,0));
        var c=cell(row,1);c.weightx=1;c.fill=GridBagConstraints.HORIZONTAL;panel.add(value,c);
        if(value instanceof JTextField text){
            JButton browse=new JButton("Browse…");describe(browse,"Browse for "+title,value.getToolTipText());inputs.add(browse);
            browse.addActionListener(e->{
                String purpose=text.getAccessibleContext().getAccessibleName();
                JFileChooser chooser=fileDialogs.chooser(purpose,text.getText());chooser.setDialogTitle(title);chooser.setFileSelectionMode(directory?JFileChooser.FILES_AND_DIRECTORIES:JFileChooser.FILES_ONLY);
                if(extension!=null)chooser.setFileFilter(new FileNameExtensionFilter(extension.toUpperCase(java.util.Locale.ROOT)+" files",extension.split(",")));
                int choice=saving?chooser.showSaveDialog(root):chooser.showOpenDialog(root);fileDialogs.remember(purpose,chooser);
                if(choice==JFileChooser.APPROVE_OPTION){
                    String selected=chooser.getSelectedFile().getAbsolutePath();if(saving&&extension!=null&&!selected.toLowerCase(java.util.Locale.ROOT).endsWith("."+extension))selected+="."+extension;
                    text.setText(selected);
                }
            });panel.add(browse,cell(row,2));
        }
    }
    private static void wide(JPanel panel,int row,JComponent value){var c=cell(row,0);c.gridwidth=3;c.weightx=1;c.fill=GridBagConstraints.HORIZONTAL;panel.add(value,c);}
    private static final String HELP="""
        CREATE
        Choose one file, an image directory or a ZIP and a new output PDF. Every supplied file
        is preserved, including unsupported objects. Reference images are derivatives.
        ZIP contents are expanded in private temporary staging and converted together;
        the transport ZIP is omitted; its name/hash are recorded. Nested ZIPs remain files, not recursively
        expanded. No input is de-identified or modified.

        SIGNING
        Signing identifies the exporting institution and makes changes detectable.
        A trusted timestamp is independent evidence of when the signature existed.
        Signing does not encrypt data or establish clinical accuracy or study completeness.
        The single Signing identity picker accepts a .p12/.pfx certificate or an
        advanced .json policy containing its certificate, timestamps and trust.
        For a .p12/.pfx, click Create and enter its
        password in the prompt. It travels only through a private process pipe;
        it is not saved, logged or placed in command-line arguments. One signing key
        per certificate file is supported by this simple flow. Keep it outside inputs.
        Loading a JSON with tsaUrl turns timestamping on without a permission prompt.
        Add trusted timestamps shows the current selection. The JSON must specify
        a TSA URL and independently trusted TSA certificates. Missing settings
        or timestamp failure stop creation. A policy requiring timestamps cannot
        be silently downgraded by unchecking the option.
        The DICOM desktop viewer checks file hashes and supported archive signatures.
        Use Validate with a trust configuration for the desktop verification report.
        No private key is embedded. See docs/SECURITY.md for configuration examples.

        VALIDATE
        Choose an archive; optionally select its original file, directory or ZIP.
        The desktop uses the configuration's veraPDF executable when supplied, then
        VERAPDF, then verapdf on PATH. A verification configuration also enables
        signature, timestamp and trust checks. Verification runs offline.
        Signing credentials are not required for verification.

        RESULTS
        PASS: the named check passed. FAIL: the named check failed.
        UNKNOWN: evidence or coverage is missing. NOT_APPLICABLE: check does not apply.
        A completed operation does not mean every check passed. Source diagnostics
        are separate from archive integrity. No result establishes clinical completeness
        or authenticated acquisition. Select a result for its evidence; save JSON
        using Save report. Replacing an existing output PDF requires confirmation and a successful conversion.

        PRIVACY AND CONTROL
        Source files remain unchanged. File dialogs remember folders locally between
        sessions; no source contents or passwords are saved as preferences.
        Details and reports may contain sensitive information; save them deliberately.
        Stop terminates the worker and validator subprocesses. Inspect any output of
        a stopped run before using it; an incomplete temporary file may remain.
        Keyboard: Alt+1/2 selects the operation; Tab moves between controls.
        Further instructions: docs/GUIDE.md and docs/SECURITY.md.
        """;
}
