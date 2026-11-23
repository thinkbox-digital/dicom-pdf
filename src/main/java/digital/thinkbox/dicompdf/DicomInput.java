package digital.thinkbox.dicompdf;

import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.lang.reflect.Modifier;
import java.security.MessageDigest;
import java.util.*;
import javax.imageio.stream.MemoryCacheImageInputStream;
import org.dcm4che3.data.*;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.imageio.plugins.dcm.*;

/** Raster-image DICOM reader. Originals are never changed by preview conversion. */
final class DicomInput {
    record Result(Map<String,String> fields, BufferedImage image, String reason, Map<String,String> displayAdjustments) {}
    record Dataset(Attributes attributes, String syntax) {}
    record Capture(Result preview,List<ReferenceInventory.Link> links) {}
    static Capture capture(SourceContent source) {
        try {
            Dataset dataset=dataset(source);
            var links=ReferenceInventory.links(dataset.attributes());
            return new Capture(inspect(source,1,false,false,true,true,true,dataset),links);
        } catch(Exception e){
            String reason=e.getMessage()==null?e.getClass().getSimpleName():e.getMessage();
            return new Capture(new Result(Map.of(),null,reason,Map.of()),List.of());
        }
    }
    private static final Set<String> IMAGE_CLASSES = imageClasses();
    private static final Set<String> MONO = Set.of("MONOCHROME1", "MONOCHROME2");
    private static final Set<String> COLOR = Set.of("RGB", "YBR_FULL", "YBR_FULL_422", "YBR_PARTIAL_422", "YBR_PARTIAL_420", "YBR_ICT", "YBR_RCT", "PALETTE COLOR");
    private static final Map<Integer,String> TAGS = new LinkedHashMap<>();
    static {
        TAGS.put(Tag.PatientName,"PatientName"); TAGS.put(Tag.PatientID,"PatientID");
        TAGS.put(Tag.StudyInstanceUID,"StudyInstanceUID"); TAGS.put(Tag.StudyDate,"StudyDate");
        TAGS.put(Tag.StudyTime,"StudyTime"); TAGS.put(Tag.StudyID,"StudyID"); TAGS.put(Tag.StudyDescription,"StudyDescription");
        TAGS.put(Tag.SeriesInstanceUID,"SeriesInstanceUID"); TAGS.put(Tag.SeriesNumber,"SeriesNumber");
        TAGS.put(Tag.SeriesDescription,"SeriesDescription"); TAGS.put(Tag.SOPInstanceUID,"SOPInstanceUID");
        TAGS.put(Tag.SOPClassUID,"SOPClassUID"); TAGS.put(Tag.InstanceNumber,"InstanceNumber"); TAGS.put(Tag.ImageType,"ImageType");
        TAGS.put(Tag.Modality,"Modality"); TAGS.put(Tag.PresentationIntentType,"PresentationIntentType");
        TAGS.put(Tag.BodyPartExamined,"BodyPartExamined"); TAGS.put(Tag.ViewPosition,"ViewPosition");
        TAGS.put(Tag.PatientOrientation,"PatientOrientation"); TAGS.put(Tag.ImageLaterality,"ImageLaterality"); TAGS.put(Tag.Laterality,"Laterality");
        TAGS.put(Tag.Rows,"Rows"); TAGS.put(Tag.Columns,"Columns"); TAGS.put(Tag.SamplesPerPixel,"SamplesPerPixel");
        TAGS.put(Tag.PlanarConfiguration,"PlanarConfiguration"); TAGS.put(Tag.PhotometricInterpretation,"PhotometricInterpretation");
        TAGS.put(Tag.BitsAllocated,"BitsAllocated"); TAGS.put(Tag.BitsStored,"BitsStored"); TAGS.put(Tag.HighBit,"HighBit");
        TAGS.put(Tag.PixelRepresentation,"PixelRepresentation"); TAGS.put(Tag.NumberOfFrames,"NumberOfFrames"); TAGS.put(Tag.FrameTime,"FrameTime");
        TAGS.put(Tag.WindowCenter,"WindowCenter"); TAGS.put(Tag.WindowWidth,"WindowWidth");
        TAGS.put(Tag.PresentationLUTShape,"PresentationLUTShape"); TAGS.put(Tag.VOILUTFunction,"VOILUTFunction");
        TAGS.put(Tag.RescaleSlope,"RescaleSlope"); TAGS.put(Tag.RescaleIntercept,"RescaleIntercept");
        TAGS.put(Tag.PixelSpacing,"PixelSpacing"); TAGS.put(Tag.ImagePositionPatient,"ImagePositionPatient");
        TAGS.put(Tag.ImageOrientationPatient,"ImageOrientationPatient");
    }
    static Result inspect(Object bytes) { return inspect(bytes,1); }
    /** One-based frame selection; PDF previews use frame 1, exploration can choose another frame. */
    static Result inspect(Object bytes, int sourceFrame) {
        return inspect(bytes,sourceFrame,false,false,true,true,true,null);
    }
    /** Reproduce older recorded policies without trusting their recorded numeric values. */
    static Result inspectForPreview(Object bytes,int sourceFrame,Map<String,String> recordedDisplay) {
        return inspectForPreview(bytes,sourceFrame,recordedDisplay,true);
    }
    static Result inspectForPreview(Object bytes,int sourceFrame,Map<String,String> recordedDisplay,boolean expandedFormats) {
        return inspectForPreview(bytes,sourceFrame,recordedDisplay,expandedFormats,expandedFormats);
    }
    static Result inspectForPreview(Object bytes,int sourceFrame,Map<String,String> recordedDisplay,
                                    boolean expandedFormats,boolean wideReferenceFormats) {
        return inspectForPreview(bytes,sourceFrame,recordedDisplay,expandedFormats,wideReferenceFormats,true);
    }
    static Result inspectForPreview(Object bytes,int sourceFrame,Map<String,String> recordedDisplay,
                                    boolean expandedFormats,boolean wideReferenceFormats,boolean currentWindowing) {
        boolean recorded=recordedDisplay!=null && !recordedDisplay.isEmpty();
        return inspect(bytes,sourceFrame,recorded && "auto-min-max-v1".equals(recordedDisplay.get("windowMethod")),
                recorded && !recordedDisplay.containsKey("geometryMethod"),expandedFormats,wideReferenceFormats,currentWindowing,null);
    }
    private static Result inspect(Object bytes,int sourceFrame,boolean legacyPadding,boolean legacyGeometry,
                                  boolean expandedFormats,boolean wideReferenceFormats,boolean currentWindowing,Dataset existing) {
        Map<String,String> fields = new LinkedHashMap<>();
        try {
            var source=SourceContent.of(bytes);
            Dataset dataset = existing==null?dataset(source):existing; Attributes attrs = dataset.attributes(); String syntax = dataset.syntax();
            fields.putAll(fields(dataset));
            String sopClass=attrs.getString(Tag.SOPClassUID);
            require(sopClass!=null && IMAGE_CLASSES.contains(sopClass), attrs.contains(Tag.DirectoryRecordSequence)
                    ? "DICOMDIR directory object has no raster preview; original and directory references are preserved"
                    : "Viewing is not supported for this DICOM object type (SOP class: " + attrs.getString(Tag.SOPClassUID,"missing") + ")");
            require(DicomCodecs.supported(syntax,expandedFormats), (expandedFormats?"No bundled decoder":"No bundled pure-Java decoder")
                    +" for transfer syntax "+syntax+" (original preserved)");
            require(!attrs.containsValue(Tag.PixelDataProviderURL)||attrs.containsValue(Tag.PixelData),"Pixel data is referenced externally; no network retrieval is performed");
            DicomCodecs.ensureConfigured();
            int frames=attrs.getInt(Tag.NumberOfFrames,1);
            require(frames>0 && sourceFrame>=1 && sourceFrame<=frames,"Source frame is outside NumberOfFrames");
            int frameIndex=sourceFrame-1;
            int rows=attrs.getInt(Tag.Rows,0),columns=attrs.getInt(Tag.Columns,0);
            require(rows>0 && columns>0 && (long)rows*columns<=16_777_216,"Invalid or excessive image dimensions (maximum 16 megapixels/frame)");
            String photo=attrs.getString(Tag.PhotometricInterpretation,"");
            boolean monochrome=MONO.contains(photo), palette=photo.equals("PALETTE COLOR");
            require(monochrome || COLOR.contains(photo),"Unsupported PhotometricInterpretation " + photo);
            int samples=attrs.getInt(Tag.SamplesPerPixel,0);
            require((monochrome||palette) ? samples==1 : samples==3,"Unsupported SamplesPerPixel for " + photo);
            int allocated=attrs.getInt(Tag.BitsAllocated,0),stored=attrs.getInt(Tag.BitsStored,allocated),high=attrs.getInt(Tag.HighBit,stored-1),signed=attrs.getInt(Tag.PixelRepresentation,0);
            boolean rgb32=wideReferenceFormats && allocated==32 && photo.equals("RGB") && signed==0
                    && (DicomCodecs.NATIVE.contains(syntax) || UID.RLELossless.equals(syntax));
            boolean jpegExtended12=wideReferenceFormats && allocated==16 && UID.JPEGExtended12Bit.equals(syntax);
            boolean validLayout=stored>=1 && stored<=allocated && (rgb32 ? high>=stored-1 && high<allocated : high==stored-1);
            require((allocated==1 || allocated==8 || allocated==16 || rgb32) && validLayout, rgb32
                    ? "Invalid Bits Stored or High Bit for 32-bit RGB"
                    : "Unsupported pixel bit layout; requires right-aligned 1/8/16-bit integer pixels");
            require(signed==0 || signed==1,"Invalid PixelRepresentation");
            require(allocated!=1 || monochrome && signed==0 && DicomCodecs.NATIVE.contains(syntax),"One-bit images require native unsigned monochrome pixels");
            require(!jpegExtended12 || monochrome && signed==0 && stored<=12,
                    "12-bit JPEG Extended requires unsigned grayscale with at most 12 Bits Stored");
            require(monochrome || palette || rgb32 || allocated==8 && signed==0,"Direct RGB/YBR currently requires unsigned 8-bit samples");
            Attributes effective=effectiveAttributes(attrs,frameIndex);
            require(!effective.contains(Tag.ModalityLUTSequence) && !effective.contains(Tag.VOILUTSequence) && !effective.contains(Tag.PresentationLUTSequence),"Modality/VOI/presentation LUT sequences are not implemented; original preserved");
            String function=monochrome?effective.getString(Tag.VOILUTFunction,"LINEAR"):"LINEAR";
            boolean exact=expandedFormats && function.equals("LINEAR_EXACT");
            if (currentWindowing && monochrome && function.equals("LINEAR")
                    && functionalGroup(attrs,frameIndex,Tag.FrameVOILUTSequence)==null
                    && singleZeroDecimal(attrs,Tag.WindowCenter) && singleZeroDecimal(attrs,Tag.WindowWidth)) {
                // The original still contains its 0/0 placeholder. Use non-padding extrema for the reference.
                effective.remove(Tag.WindowCenter);
                effective.remove(Tag.WindowWidth);
            }
            require(function.equals("LINEAR") || exact,expandedFormats
                    ? "Unsupported grayscale VOI LUT Function "+function+" (original preserved)"
                    : "Only LINEAR grayscale VOI is currently implemented");
            String shape=effective.getString(Tag.PresentationLUTShape);
            require(shape==null || Set.of("IDENTITY","INVERSE").contains(shape),"Unsupported PresentationLUTShape " + shape);
            double slope=exact?effective.getDouble(Tag.RescaleSlope,1):effective.getFloat(Tag.RescaleSlope,1);
            double intercept=exact?effective.getDouble(Tag.RescaleIntercept,0):effective.getFloat(Tag.RescaleIntercept,0);
            require(Double.isFinite(slope) && slope!=0 && Double.isFinite(intercept),"Invalid linear rescale values");
            if (rgb32) {
                int planar=attrs.getInt(Tag.PlanarConfiguration,0);
                require(planar==0 || planar==1,"Invalid 32-bit RGB Planar Configuration");
                var image=Rgb32Reader.read(source,syntax,frameIndex,frames,rows,columns,planar,stored,high);
                var display=display(effective,attrs,null,frameIndex,sourceFrame,slope,intercept,stored,signed,
                        true,legacyPadding,legacyGeometry,false,"32-bit RGB");
                return new Result(Collections.unmodifiableMap(fields),image,null,display);
            }
            var reader=new DicomImageReader(new DicomImageReaderSpi());
            try (var input=jpegExtended12?null:source.imageInput();
                 var deflated=UID.DeflatedExplicitVRLittleEndian.equals(syntax)?new DicomInputStream(SourceContent.of(bytes).open()):null) {
                int renderFrame=frameIndex;
                if (allocated==1) { reader.setInput(unpackOneBit(bytes,effective,frameIndex,rows,columns)); renderFrame=0; }
                else if (jpegExtended12) {
                    reader.setInput(JpegExtended.unpack(source,effective,frameIndex,rows,columns));
                    renderFrame=0;
                } else reader.setInput(deflated==null?input:deflated);
                var param=(DicomImageReadParam)reader.getDefaultReadParam();
                Map<String,String> display=display(effective,attrs,reader,renderFrame,sourceFrame,slope,intercept,stored,signed,
                        !monochrome,legacyPadding,legacyGeometry,exact,jpegExtended12?"JPEG Extended / dcm4che 5.33.1":"dcm4che 5.33.1");
                param.setAutoWindowing(false); param.setPreferWindow(true); param.setOverlayActivationMask(0);
                if (monochrome && !exact) {
                    param.setWindowCenter(Float.parseFloat(display.get("windowCenter")));
                    param.setWindowWidth(Float.parseFloat(display.get("windowWidth")));
                }
                BufferedImage image;
                if (exact) {
                    image=renderExact(reader.readRaster(renderFrame,param),stored,signed,display);
                } else if (deflated!=null && allocated!=1 && (display.get("windowMethod").equals("auto-min-max-v1")
                        || currentWindowing && display.get("windowMethod").equals("auto-min-max-padding-v2"))) {
                    // Stream inputs cannot seek back after auto-window raster inspection.
                    try (var renderInput=new DicomInputStream(SourceContent.of(bytes).open())) {
                        reader.setInput(renderInput); image=reader.read(renderFrame,param);
                    }
                } else image=reader.read(renderFrame,param);
                require(image!=null,"dcm4che returned no image");
                return new Result(Collections.unmodifiableMap(fields),image,null,display);
            } finally { reader.dispose(); }
        } catch (Exception e) {
            String reason=e.getMessage();
            return new Result(Collections.unmodifiableMap(fields),null,reason==null?e.getClass().getSimpleName():reason,Map.of());
        }
    }
    private static final java.util.regex.Pattern ZERO_DECIMAL =
            java.util.regex.Pattern.compile("[+-]?(?:0+(?:\\.0*)?|\\.0+)(?:[Ee][+-]?[0-9]+)?");
    private static boolean singleZeroDecimal(Attributes attrs,int tag) {
        if (attrs.getVR(tag)!=VR.DS) return false;
        String[] values=attrs.getStrings(tag);
        return values!=null && values.length==1 && values[0]!=null && ZERO_DECIMAL.matcher(values[0].strip()).matches();
    }

    private static Set<String> imageClasses() {
        Set<String> classes=new HashSet<>();
        for (var field:UID.class.getFields()) if (field.getType()==String.class && Modifier.isStatic(field.getModifiers()) && field.getName().contains("ImageStorage")) {
            try { classes.add((String)field.get(null)); } catch (IllegalAccessException e) { throw new ExceptionInInitializerError(e); }
        }
        classes.add(UID.SegmentationStorage);
        return Set.copyOf(classes);
    }
    static Dataset dataset(Object bytes) throws Exception {
        try (var in=new DicomInputStream(SourceContent.of(bytes).open())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.NO);
            in.setBulkDataDescriptor((items,creator,tag,vr,length)->tag!=Tag.PixelDataProviderURL&&org.dcm4che3.io.BulkDataDescriptor.DEFAULT.isBulkData(items,creator,tag,vr,length));
            require(in.readFileMetaInformation()!=null,"DICOM Part 10 file meta information is required");
            String syntax=in.getTransferSyntax();
            return new Dataset(in.readDataset(),syntax);
        }
    }
    static Map<String,String> fields(Object bytes) {
        try { return fields(dataset(bytes)); } catch (Exception e) { return Map.of(); }
    }
    static Map<String,String> fields(Dataset dataset) {
        Attributes attrs=dataset.attributes(); Map<String,String> result=new LinkedHashMap<>();
        for (var tag:TAGS.entrySet()) {
            String[] values=attrs.getStrings(tag.getKey());
            if (values!=null && values.length>0) {
                String value=String.join("\\",values);
                if (!value.isBlank()) result.put(tag.getValue(),value);
            }
        }
        result.put("TransferSyntaxUID",dataset.syntax());
        copyCodes(attrs,Tag.AnatomicRegionSequence,"AnatomicRegion",result);
        copyCodes(attrs,Tag.PrimaryAnatomicStructureSequence,"PrimaryAnatomicStructure",result);
        return Collections.unmodifiableMap(result);
    }
    private static Attributes functionalGroup(Attributes attrs,int frameIndex,int sequence) {
        Attributes per=attrs.getNestedDataset(Tag.PerFrameFunctionalGroupsSequence,frameIndex);
        Attributes selected=per==null?null:per.getNestedDataset(sequence);
        if (selected!=null) return selected;
        Attributes shared=attrs.getNestedDataset(Tag.SharedFunctionalGroupsSequence);
        return shared==null?null:shared.getNestedDataset(sequence);
    }
    static Attributes effectiveAttributes(Attributes attrs,int frameIndex) {
        Attributes effective=new Attributes(attrs);
        Attributes rescale=functionalGroup(attrs,frameIndex,Tag.PixelValueTransformationSequence);
        if (rescale!=null) {
            effective.remove(Tag.RescaleSlope); effective.remove(Tag.RescaleIntercept); effective.remove(Tag.ModalityLUTSequence);
            // dcm4che addSelected requires tag arguments in ascending order.
            effective.addSelected(rescale,Tag.RescaleIntercept,Tag.RescaleSlope,Tag.ModalityLUTSequence);
        }
        Attributes voi=functionalGroup(attrs,frameIndex,Tag.FrameVOILUTSequence);
        if (voi!=null) {
            effective.remove(Tag.WindowCenter); effective.remove(Tag.WindowWidth); effective.remove(Tag.VOILUTFunction); effective.remove(Tag.VOILUTSequence);
            effective.addSelected(voi,Tag.WindowCenter,Tag.WindowWidth,Tag.VOILUTFunction,Tag.VOILUTSequence);
        }
        return effective;
    }
    private static DicomMetaData unpackOneBit(Object bytes,Attributes effective,int frameIndex,int rows,int columns) throws Exception {
        int pixels=rows*columns;
        long bitOffset=(long)frameIndex*pixels;
        long start=bitOffset>>>3;
        long end=(bitOffset+pixels+7)>>>3;
        byte[] packed;
        boolean swap;
        try(var in=new DicomInputStream(SourceContent.of(bytes).open())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.NO);
            in.readDatasetUntilPixelData();
            require(in.tag()==Tag.PixelData,"Missing/truncated one-bit PixelData");
            swap=in.bigEndian() && in.vr()==VR.OW;
            if(swap){start&=~1L;end=(end+1)&~1L;}
            long length=in.unsignedLength();
            require(end<=length,"Missing/truncated one-bit PixelData");
            in.skipFully(start);
            packed=new byte[Math.toIntExact(end-start)];
            in.readFully(packed);
            // Seek through the unused tail but confirm its final byte really exists.
            if(length>end){in.skipFully(length-end-1);require(in.read()!=-1,"Missing/truncated one-bit PixelData");}
        }
        byte[] unpacked=new byte[pixels];
        for(int i=0;i<pixels;i++){
            long bit=bitOffset+i;
            int index=(int)((bit>>>3)-start);
            if(swap)index^=1;
            unpacked[i]=(byte)((packed[index]>>>(bit&7))&1);
        }
        Attributes image=new Attributes(effective,false);
        image.remove(Tag.SharedFunctionalGroupsSequence); image.remove(Tag.PerFrameFunctionalGroupsSequence);
        image.setInt(Tag.NumberOfFrames,VR.IS,1); image.setInt(Tag.BitsAllocated,VR.US,8);
        image.setInt(Tag.BitsStored,VR.US,1); image.setInt(Tag.HighBit,VR.US,0);
        image.setBytes(Tag.PixelData,VR.OB,unpacked);
        return new DicomMetaData(image.createFileMetaInformation(UID.ExplicitVRLittleEndian),image);
    }
    private static Map<String,String> display(Attributes effective,Attributes source,DicomImageReader reader,int renderFrame,int sourceFrame,
                                             double slope,double intercept,int stored,int signed,boolean color,boolean legacyPadding,
                                             boolean legacyGeometry,boolean exact,String renderer) throws Exception {
        double center,width; String method;
        int[] padding=null;
        boolean paddingWindow=false;
        if (color) { center=127.5f; width=255; slope=1; intercept=0; method="color-direct"; }
        else if (exact || effective.containsValue(Tag.WindowCenter) && effective.containsValue(Tag.WindowWidth)) {
            center=exact?effective.getDouble(Tag.WindowCenter,Double.NaN):effective.getFloat(Tag.WindowCenter,Float.NaN);
            width=exact?effective.getDouble(Tag.WindowWidth,Double.NaN):effective.getFloat(Tag.WindowWidth,Float.NaN);
            require(Double.isFinite(center) && Double.isFinite(width) && (exact?width>0:width>=1),"Invalid source window center/width");
            method="source-window-0";
        } else {
            if (!legacyPadding) padding=paddingRange(source,stored,signed);
            var raster=reader.readRaster(renderFrame,reader.getDefaultReadParam());
            int min=Integer.MAX_VALUE,max=Integer.MIN_VALUE,mask=(1<<stored)-1,sign=1<<(stored-1);
            for (int y=0;y<raster.getHeight();y++) for (int x=0;x<raster.getWidth();x++) {
                int value=raster.getSample(x,y,0)&mask;
                if (signed==1 && value>=sign) value-=1<<stored;
                if (padding!=null && value>=padding[0] && value<=padding[1]) continue;
                min=Math.min(min,value); max=Math.max(max,value);
            }
            require(min<=max,"No non-padding pixels are available for automatic windowing");
            double low=Math.min(min*slope+intercept,max*slope+intercept),high=Math.max(min*slope+intercept,max*slope+intercept);
            width=(float)Math.max(1,high-low+1); center=(float)((low+high+1)/2);
            require(Double.isFinite(center) && Double.isFinite(width),"Invalid automatic display window");
            paddingWindow=padding!=null;
            method=paddingWindow?"auto-min-max-padding-v2":"auto-min-max-v1";
        }
        String photo=effective.getString(Tag.PhotometricInterpretation,"");
        String shape=effective.getString(Tag.PresentationLUTShape);
        boolean invert=!color && (shape==null?photo.equals("MONOCHROME1"):shape.equals("INVERSE"));
        Map<String,String> result=new LinkedHashMap<>();
        result.put("renderer",renderer);
        result.put("windowCenter",exact?Double.toString(center):Float.toString((float)center));
        result.put("windowWidth",exact?Double.toString(width):Float.toString((float)width));
        result.put("windowMethod",method);
        result.put("rescaleSlope",exact?Double.toString(slope):Float.toString((float)slope));
        result.put("rescaleIntercept",exact?Double.toString(intercept):Float.toString((float)intercept));
        result.put("invert",Boolean.toString(invert)); result.put("voiLUTFunction",exact?"LINEAR_EXACT":"LINEAR"); result.put("rotationDegrees","0");
        result.put("flipHorizontal","false"); result.put("flipVertical","false"); result.put("overlayPolicy","disabled"); result.put("pixelAspectRatio","1:1");
        result.put("color",Boolean.toString(color)); result.put("photometricInterpretation",photo); result.put("sourceFrame",Integer.toString(sourceFrame));
        result.put("rescaleSource",functionalGroup(source,sourceFrame-1,Tag.PixelValueTransformationSequence)==null?"dataset":"functional-groups");
        result.put("windowSource",functionalGroup(source,sourceFrame-1,Tag.FrameVOILUTSequence)==null?"dataset":"functional-groups");
        if (paddingWindow) {
            result.put("paddingPolicy","exclude-stored-range");
            result.put("pixelPaddingMin",Integer.toString(padding[0])); result.put("pixelPaddingMax",Integer.toString(padding[1]));
        }
        if (!legacyGeometry) {
            Geometry geometry=geometry(source,sourceFrame-1);
            if (Math.abs(geometry.rowRatio()-1)>1e-9) {
                result.put("pixelAspectRatio",Double.toString(geometry.rowRatio())+":1");
                result.put("geometryMethod","source-aspect-v1"); result.put("geometrySource",geometry.source());
            }
        }
        return Collections.unmodifiableMap(result);
    }
    private static BufferedImage renderExact(java.awt.image.Raster raster,int stored,int signed,Map<String,String> display) {
        double center=Double.parseDouble(display.get("windowCenter")),width=Double.parseDouble(display.get("windowWidth"));
        double slope=Double.parseDouble(display.get("rescaleSlope")),intercept=Double.parseDouble(display.get("rescaleIntercept"));
        boolean invert=Boolean.parseBoolean(display.get("invert"));
        var image=new BufferedImage(raster.getWidth(),raster.getHeight(),BufferedImage.TYPE_INT_RGB);
        int[] row=new int[image.getWidth()];
        int range=1<<stored, sign=range>>>1;
        for (int y=0;y<image.getHeight();y++) {
            raster.getSamples(raster.getMinX(),raster.getMinY()+y,row.length,1,0,row);
            for (int x=0;x<row.length;x++) {
                int value=row[x]&(range-1);
                if (signed==1 && value>=sign) value-=range;
                double fraction=Math.clamp((value*slope+intercept-center)/width+0.5,0d,1d);
                int gray=(int)Math.rint((invert?1-fraction:fraction)*255);
                row[x]=gray*0x010101;
            }
            image.getRaster().setDataElements(0,y,row.length,1,row);
        }
        return image;
    }
    private static int[] paddingRange(Attributes source,int stored,int signed) {
        if (!source.containsValue(Tag.PixelPaddingValue)) return null;
        int value=source.getInt(Tag.PixelPaddingValue,0),limit=source.getInt(Tag.PixelPaddingRangeLimit,value);
        int minimum=signed==1?-(1<<(stored-1)):0,maximum=signed==1?(1<<(stored-1))-1:(1<<stored)-1;
        require(value>=minimum && value<=maximum && limit>=minimum && limit<=maximum,"Pixel padding is outside the stored sample range");
        return new int[]{Math.min(value,limit),Math.max(value,limit)};
    }
    private record Geometry(double rowRatio,String source) {}
    private static Geometry geometry(Attributes source,int frameIndex) {
        Attributes measures=functionalGroup(source,frameIndex,Tag.PixelMeasuresSequence);
        if (measures!=null && measures.containsValue(Tag.PixelSpacing)) return spacing(measures,Tag.PixelSpacing,"functional-groups.PixelSpacing",source.getInt(Tag.Rows,0),source.getInt(Tag.Columns,0));
        for (int tag:new int[]{Tag.PixelSpacing,Tag.ImagerPixelSpacing,Tag.NominalScannedPixelSpacing,Tag.PixelAspectRatio})
            if (source.containsValue(tag)) return spacing(source,tag,ElementDictionary.keywordOf(tag,null),source.getInt(Tag.Rows,0),source.getInt(Tag.Columns,0));
        return new Geometry(1,"unspecified");
    }
    private static Geometry spacing(Attributes source,int tag,String name,int rows,int columns) {
        String[] values=source.getStrings(tag);
        double[] pair=values==null?null:Arrays.stream(values).mapToDouble(Double::parseDouble).toArray();
        require(pair!=null && pair.length==2 && Double.isFinite(pair[0]) && Double.isFinite(pair[1]),"Invalid "+name+" pair");
        if (tag==Tag.PixelAspectRatio) require(pair[0]>0 && pair[1]>0 && pair[0]==Math.rint(pair[0]) && pair[1]==Math.rint(pair[1]),"PixelAspectRatio requires two positive integers");
        else require(pair[0]>=0 && pair[1]>=0 && (pair[0]!=0 || rows==1) && (pair[1]!=0 || columns==1),"Invalid "+name+" spacing");
        // A zero spacing for a singleton dimension has no useful display ratio.
        if (pair[0]==0 || pair[1]==0) return new Geometry(1,name);
        double ratio=pair[0]/pair[1];
        require(Double.isFinite(ratio) && ratio>=1e-6 && ratio<=1e6,"Invalid or excessive "+name+" aspect ratio");
        return new Geometry(ratio,name);
    }
    /** SHA-256 over RGB8 row-major R,G,B bytes, without alpha/header. */
    static String previewSha256(BufferedImage image) throws Exception {
        var digest=MessageDigest.getInstance("SHA-256"); BufferedImage rgb=rgb(image); byte[] row=new byte[rgb.getWidth()*3];
        int[] pixels=new int[rgb.getWidth()];
        for (int y=0;y<rgb.getHeight();y++) {
            rgb.getRaster().getDataElements(0,y,rgb.getWidth(),1,pixels);
            for (int x=0;x<rgb.getWidth();x++) {
                int value=pixels[x]; row[x*3]=(byte)(value>>16); row[x*3+1]=(byte)(value>>8); row[x*3+2]=(byte)value;
            }
            digest.update(row);
        }
        return HexFormat.of().formatHex(digest.digest());
    }
    static BufferedImage rgb(BufferedImage image) {
        if (image.getType()==BufferedImage.TYPE_INT_RGB) return image;
        var rgb=new BufferedImage(image.getWidth(),image.getHeight(),BufferedImage.TYPE_INT_RGB);
        var graphics=rgb.createGraphics();try{graphics.drawImage(image,0,0,null);}finally{graphics.dispose();}
        return rgb;
    }
    private static void copyCodes(Attributes attrs,int tag,String prefix,Map<String,String> result) {
        Sequence sequence=attrs.getSequence(tag);if(sequence==null)return;
        for(int i=0;i<sequence.size();i++) for(int codeTag:new int[]{Tag.CodeValue,Tag.CodingSchemeDesignator,Tag.CodeMeaning}) {
            String value=sequence.get(i).getString(codeTag);
            if(value!=null&&!value.isBlank()) result.put(prefix+"["+i+"]."+ElementDictionary.keywordOf(codeTag,null),value);
        }
    }
    private static void require(boolean test,String reason){if(!test)throw new IllegalArgumentException(reason);}
}
